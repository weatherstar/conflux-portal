import abiDecoder from 'abi-decoder'
import * as ethUtil from 'cfx-util'
import { ethErrors } from 'eth-json-rpc-errors'
import abi from 'human-standard-token-abi'
import Transaction from 'js-conflux-sdk/src/Transaction'
import log from 'loglevel'
import NonceTracker from 'nonce-tracker'
import ObservableStore from 'obs-store'
import EventEmitter from 'safe-event-emitter'
import {
  CONTRACT_INTERACTION_KEY,
  DEPLOY_CONTRACT_ACTION_KEY,
  SEND_ETHER_ACTION_KEY,
  TOKEN_METHOD_APPROVE,
  TOKEN_METHOD_TRANSFER,
  TOKEN_METHOD_TRANSFER_FROM,
} from '../../../../ui/app/helpers/constants/transactions.js'
import EthQuery from '../../ethjs-query'
import cleanErrorStack from '../../lib/cleanErrorStack'
import { BnMultiplyByFraction, bnToHex, hexToBn } from '../../lib/util'
import {
  TRANSACTION_STATUS_APPROVED,
  TRANSACTION_TYPE_CANCEL,
  TRANSACTION_TYPE_RETRY,
  TRANSACTION_TYPE_STANDARD,
} from './enums'
import recipientBlacklistChecker from './lib/recipient-blacklist-checker'
import * as txUtils from './lib/util'
import PendingTransactionTracker from './pending-tx-tracker'
import TxGasUtil, { SIMPLE_GAS_COST } from './tx-gas-utils'
import TransactionStateManager from './tx-state-manager'

abiDecoder.addABI(abi)

/**
  Transaction Controller is an aggregate of sub-controllers and trackers
  composing them in a way to be exposed to the metamask controller
    <br>- txStateManager
      responsible for the state of a transaction and
      storing the transaction
    <br>- pendingTxTracker
      watching blocks for transactions to be include
      and emitting confirmed events
    <br>- txGasUtil
      gas calculations and safety buffering
    <br>- nonceTracker
      calculating nonces


  @class
  @param {Object} - opts
  @param {Object}  opts.initState - initial transaction list default is an empty array
  @param {Object}  opts.networkStore - an observable store for network number
  @param {Object}  opts.blockTracker - An instance of eth-blocktracker
  @param {Object}  opts.provider - A network provider.
  @param {Function}  opts.signTransaction - function the signs an ethereumjs-tx
  @param {Object}  opts.getPermittedAccounts - get accounts that an origin has permissions for
  @param {Function}  opts.signTransaction - ethTx signer that returns a rawTx
  @param {number}  [opts.txHistoryLimit] - number *optional* for limiting how many transactions are in state
  @param {Object}  opts.preferencesStore
*/

class TransactionController extends EventEmitter {
  constructor(opts) {
    super()
    this.networkStore = opts.networkStore || new ObservableStore({})
    this.preferencesStore = opts.preferencesStore || new ObservableStore({})
    this.provider = opts.provider
    this.getPermittedAccounts = opts.getPermittedAccounts
    this.blockTracker = opts.blockTracker
    this.signEthTx = opts.signTransaction
    this.inProcessOfSigning = new Set()

    this.memStore = new ObservableStore({})
    this.query = new EthQuery(this.provider)
    this.txGasUtil = new TxGasUtil(this.provider)

    this._mapMethods()
    this.txStateManager = new TransactionStateManager({
      initState: opts.initState,
      txHistoryLimit: opts.txHistoryLimit,
      getNetwork: this.getNetwork.bind(this),
    })
    this._onBootCleanUp()

    this.store = this.txStateManager.store
    this.nonceTracker = new NonceTracker({
      provider: this.provider,
      blockTracker: this.blockTracker,
      getPendingTransactions: this.txStateManager.getSubmittedTransactions.bind(
        this.txStateManager
      ),
      getConfirmedTransactions: address => {
        const executed = this.txStateManager.getExecutedTransactions(address)
        const confirmed = this.txStateManager.getConfirmedTransactions(address)
        return [...executed, ...confirmed]
      },
    })

    this.pendingTxTracker = new PendingTransactionTracker({
      provider: this.provider,
      nonceTracker: this.nonceTracker,
      publishTransaction: rawTx => this.query.sendRawTransaction(rawTx),
      getPendingTransactions: () => {
        // submitted and executed transaction
        const pending = this.txStateManager.getPendingTransactions()
        const approved = this.txStateManager.getApprovedTransactions()
        return [...pending, ...approved]
      },
      approveTransaction: this.approveTransaction.bind(this),
      getCompletedTransactions: address => {
        const executed = this.txStateManager.getExecutedTransactions(address)
        const confirmed = this.txStateManager.getConfirmedTransactions(address)
        return [...executed, ...confirmed]
      },
    })

    this.txStateManager.store.subscribe(() => this.emit('update:badge'))
    this._setupListeners()
    // memstore is computed from a few different stores
    this._updateMemstore()
    this.txStateManager.store.subscribe(() => this._updateMemstore())
    this.networkStore.subscribe(() => {
      this._onBootCleanUp()
      this._updateMemstore()
    })
    this.preferencesStore.subscribe(() => this._updateMemstore())

    // request state update to finalize initialization
    this._updatePendingTxsAfterFirstBlock()
  }

  /** @returns {number} - the chainId*/
  getChainId() {
    const networkState = this.networkStore.getState()
    const getChainId = parseInt(networkState, 10)
    if (Number.isNaN(getChainId)) {
      throw new Error('invalid chainId NaN')
    } else {
      return `0x${getChainId.toString(16)}`
    }
  }

  /**
  Adds a tx to the txlist
  @emits ${txMeta.id}:unapproved
  */
  addTx(txMeta) {
    this.txStateManager.addTx(txMeta)
    this.emit(`${txMeta.id}:unapproved`, txMeta)
  }

  /**
  Wipes the transactions for a given account
  @param {string} address - hex string of the from address for txs being removed
  */
  wipeTransactions(address) {
    this.txStateManager.wipeTransactions(address)
  }

  /**
   * Add a new unapproved transaction to the pipeline
   *
   * @returns {Promise<string>} - the hash of the transaction after being submitted to the network
   * @param {Object} txParams - txParams for the transaction
   * @param {Object} opts - with the key origin to put the origin on the txMeta
   */
  async newUnapprovedTransaction(txParams, opts = {}) {
    log.debug(
      `MetaMaskController newUnapprovedTransaction ${JSON.stringify(txParams)}`
    )

    const initialTxMeta = await this.addUnapprovedTransaction(
      txParams,
      opts.origin
    )

    // listen for tx completion (success, fail)
    return await new Promise((resolve, reject) => {
      this.txStateManager.once(
        `${initialTxMeta.id}:finished`,
        finishedTxMeta => {
          switch (finishedTxMeta.status) {
            case 'submitted':
              return resolve(finishedTxMeta.hash)
            case 'rejected':
              return reject(
                cleanErrorStack(
                  ethErrors.provider.userRejectedRequest(
                    'ConfluxPortal Tx Signature: User denied transaction signature.'
                  )
                )
              )
            case 'failed':
              return reject(
                cleanErrorStack(
                  ethErrors.rpc.internal(finishedTxMeta.err.message)
                )
              )
            default:
              return reject(
                cleanErrorStack(
                  ethErrors.rpc.internal(
                    `ConfluxPortal Tx Signature: Unknown problem: ${JSON.stringify(
                      finishedTxMeta.txParams
                    )}`
                  )
                )
              )
          }
        }
      )
    })
  }

  /**
   * Validates and generates a txMeta with defaults and puts it in txStateManager
   * store.
   *
   * @returns {txMeta}
   */
  async addUnapprovedTransaction(txParams, origin) {
    // validate
    const normalizedTxParams = txUtils.normalizeTxParams(txParams)

    txUtils.validateTxParams(normalizedTxParams)
    /**
    `generateTxMeta` adds the default txMeta properties to the passed object.
    These include the tx's `id`. As we use the id for determining order of
    txes in the tx-state-manager, it is necessary to call the asynchronous
    method `this._determineTransactionCategory` after `generateTxMeta`.
    */
    let txMeta = this.txStateManager.generateTxMeta({
      txParams: normalizedTxParams,
      type: TRANSACTION_TYPE_STANDARD,
    })

    if (origin === 'metamask') {
      // Assert the from address is the selected address
      if (normalizedTxParams.from !== this.getSelectedAddress()) {
        throw ethErrors.rpc.internal({
          message: `Internally initiated transaction is using invalid account.`,
          data: {
            origin,
            fromAddress: normalizedTxParams.from,
            selectedAddress: this.getSelectedAddress(),
          },
        })
      }
    } else {
      // Assert that the origin has permissions to initiate transactions from
      // the specified address
      const permittedAddresses = await this.getPermittedAccounts(origin)
      if (!permittedAddresses.includes(normalizedTxParams.from)) {
        throw ethErrors.provider.unauthorized({ data: { origin } })
      }
    }

    txMeta['origin'] = origin

    const {
      transactionCategory,
      getCodeResponse,
    } = await this._determineTransactionCategory(txParams)
    txMeta.transactionCategory = transactionCategory
    this.addTx(txMeta)
    this.emit('newUnapprovedTx', txMeta)

    try {
      // check whether recipient account is blacklisted
      recipientBlacklistChecker.checkAccount(
        txMeta.metamaskNetworkId,
        normalizedTxParams.to
      )
      // add default tx params
      txMeta = await this.addTxGasAndCollateralDefaults(txMeta, getCodeResponse)
      txMeta = await this.addTxSponsorshipInfo(txMeta)
    } catch (error) {
      log.warn(error)
      txMeta.loadingDefaults = false
      this.txStateManager.updateTx(txMeta, 'Failed to calculate gas defaults.')
      throw error
    }

    txMeta.loadingDefaults = false

    // save txMeta
    this.txStateManager.updateTx(txMeta, 'Added new unapproved transaction.')

    return txMeta
  }

  /**
   * Adds the tx gas defaults: gas && gasPrice
   * @param {Object} txMeta - the txMeta object
   * @returns {Promise<object>} - resolves with txMeta
   */
  async addTxGasAndCollateralDefaults(txMeta, getCodeResponse) {
    const txParams = txMeta.txParams
    // ensure value
    txParams.value = txParams.value
      ? ethUtil.addHexPrefix(txParams.value)
      : '0x0'
    txMeta.gasPriceSpecified = Boolean(txParams.gasPrice)
    let gasPrice = txParams.gasPrice
    const isMainnet = txMeta.metamaskNetworkId === '1029'
    if (isMainnet) {
      const res = await fetch('https://main.confluxrpc.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'gasstation_price',
          params: [],
        }),
      }).then(res => res.json())
      if (res && res.result && res.result.fastest) {
        if (!gasPrice || res.result.fastest > gasPrice) {
          gasPrice = res.result.fastest
        }
      } else {
        gasPrice = 1000000000
      }
    } else {
      if (!gasPrice) {
        gasPrice = 1
      }
    }
    txParams.gasPrice = ethUtil.addHexPrefix(gasPrice.toString(16))
    // set gasLimit
    return await this.txGasUtil.analyzeGasUsage(txMeta, getCodeResponse)
  }

  async addTxSponsorshipInfo(txMeta) {
    const {
      txParams: { gasPrice, gas, storageLimit, to, from },
    } = txMeta

    let sponsorshipInfo = {
      isBalanceEnough: true,
      willPayCollateral: true,
      willPayTxFee: true,
    }

    if (to) {
      sponsorshipInfo = await new Promise(resolve => {
        this.query.checkBalanceAgainstTransaction(
          from,
          to,
          gas,
          gasPrice,
          storageLimit,
          (err, res) => {
            if (err) {
              resolve(sponsorshipInfo)
            }
            resolve(res)
          }
        )
      })
    }
    const { isBalanceEnough, willPayCollateral, willPayTxFee } = sponsorshipInfo
    txMeta.isUserBalanceEnough = isBalanceEnough
    txMeta.willUserPayCollateral = willPayCollateral
    txMeta.willUserPayTxFee = willPayTxFee

    return txMeta
  }

  /**
    Creates a new txMeta with the same txParams as the original
    to allow the user to resign the transaction with a higher gas values
    @param {number} originalTxId - the id of the txMeta that
    you want to attempt to retry
    @param {string} [gasPrice] - Optional gas price to be increased to use as the retry
    transaction's gas price
    @returns {txMeta}
  */

  async retryTransaction(originalTxId, gasPrice) {
    const originalTxMeta = this.txStateManager.getTx(originalTxId)
    const { txParams } = originalTxMeta
    const lastGasPrice = gasPrice || originalTxMeta.txParams.gasPrice
    // const suggestedGasPriceBN = new ethUtil.BN(
    //   ethUtil.stripHexPrefix(await this.query.gasPrice()),
    //   16
    // )
    const lastGasPriceBN = new ethUtil.BN(
      ethUtil.stripHexPrefix(lastGasPrice),
      16
    )
    // essentially lastGasPrice * 1.1 but
    // dont trust decimals so a round about way of doing that
    const lastGasPriceBNBumped = lastGasPriceBN
      .mul(new ethUtil.BN(110, 10))
      .div(new ethUtil.BN(100, 10))
    // XXX: don't use gasPrice method, just bump the original gas price by 10
    // // transactions that are being retried require a >=%10 bump or the clients will throw an error
    // txParams.gasPrice = suggestedGasPriceBN.gt(lastGasPriceBNBumped)
    //   ? `0x${suggestedGasPriceBN.toString(16)}`
    //   : `0x${lastGasPriceBNBumped.toString(16)}`
    txParams.gasPrice = `0x${lastGasPriceBNBumped.toString(16)}`

    const txMeta = this.txStateManager.generateTxMeta({
      txParams: originalTxMeta.txParams,
      lastGasPrice,
      loadingDefaults: false,
      type: TRANSACTION_TYPE_RETRY,
    })
    this.addTx(txMeta)
    this.emit('newUnapprovedTx', txMeta)
    return txMeta
  }

  /**
   * Creates a new approved transaction to attempt to cancel a previously submitted transaction. The
   * new transaction contains the same nonce as the previous, is a basic ETH transfer of 0x value to
   * the sender's address, and has a higher gasPrice than that of the previous transaction.
   * @param {number} originalTxId - the id of the txMeta that you want to attempt to cancel
   * @param {string} [customGasPrice] - the hex value to use for the cancel transaction
   * @returns {txMeta}
   */
  async createCancelTransaction(originalTxId, customGasPrice) {
    const originalTxMeta = this.txStateManager.getTx(originalTxId)
    const { txParams } = originalTxMeta
    const { gasPrice: lastGasPrice, from, nonce } = txParams

    const newGasPrice =
      customGasPrice ||
      bnToHex(BnMultiplyByFraction(hexToBn(lastGasPrice), 11, 10))
    const newTxMeta = this.txStateManager.generateTxMeta({
      txParams: {
        from,
        to: from,
        nonce,
        gas: SIMPLE_GAS_COST,
        value: '0x0',
        gasPrice: newGasPrice,
      },
      lastGasPrice,
      loadingDefaults: false,
      status: TRANSACTION_STATUS_APPROVED,
      type: TRANSACTION_TYPE_CANCEL,
    })

    this.addTx(newTxMeta)
    await this.approveTransaction(newTxMeta.id)
    return newTxMeta
  }

  async createSpeedUpTransaction(originalTxId, customGasPrice) {
    const originalTxMeta = this.txStateManager.getTx(originalTxId)
    const { txParams } = originalTxMeta
    const { gasPrice: lastGasPrice } = txParams

    const newGasPrice =
      customGasPrice ||
      bnToHex(BnMultiplyByFraction(hexToBn(lastGasPrice), 11, 10))

    const newTxMeta = this.txStateManager.generateTxMeta({
      txParams: {
        ...txParams,
        gasPrice: newGasPrice,
      },
      lastGasPrice,
      loadingDefaults: false,
      status: TRANSACTION_STATUS_APPROVED,
      type: TRANSACTION_TYPE_RETRY,
    })

    this.addTx(newTxMeta)
    await this.approveTransaction(newTxMeta.id)
    return newTxMeta
  }

  /**
  updates the txMeta in the txStateManager
  @param {Object} txMeta - the updated txMeta
  */
  async updateTransaction(txMeta) {
    this.txStateManager.updateTx(
      await this.addTxSponsorshipInfo(txMeta),
      'confTx: user updated transaction'
    )
  }

  /**
  updates and approves the transaction
  @param {Object} txMeta
  */
  async updateAndApproveTransaction(txMeta) {
    this.txStateManager.updateTx(txMeta, 'confTx: user approved transaction')
    await this.approveTransaction(txMeta.id)
  }

  /**
  sets the tx status to approved
  auto fills the nonce
  signs the transaction
  publishes the transaction
  if any of these steps fails the tx status will be set to failed
    @param {number} txId - the tx's Id
  */
  async approveTransaction(txId) {
    // TODO: Move this safety out of this function.
    // Since this transaction is async,
    // we need to keep track of what is currently being signed,
    // So that we do not increment nonce + resubmit something
    // that is already being incrmented & signed.
    if (this.inProcessOfSigning.has(txId)) {
      return
    }
    this.inProcessOfSigning.add(txId)
    let nonceLock
    try {
      // approve
      this.txStateManager.setTxStatusApproved(txId)
      // get next nonce
      const txMeta = this.txStateManager.getTx(txId)
      txMeta.txParams.epochHeight = await this.blockTracker.getLatestBlock()
      const fromAddress = txMeta.txParams.from
      txMeta.txParams.chainId = this.getChainId()
      // wait for a nonce
      let { customNonceValue = null } = txMeta
      customNonceValue =
        customNonceValue === null ? null : Number(customNonceValue)
      nonceLock = await this.nonceTracker.getNonceLock(fromAddress)
      // add nonce to txParams
      // if txMeta has lastGasPrice then it is a retry at same nonce with higher
      // gas price transaction and their for the nonce should not be calculated
      const nonce = txMeta.lastGasPrice
        ? txMeta.txParams.nonce
        : nonceLock.nextNonce
      let customOrNonce

      if (customNonceValue === 0) {
        customOrNonce = 0
      } else {
        customOrNonce = customNonceValue || nonce
      }

      txMeta.txParams.nonce = ethUtil.addHexPrefix(customOrNonce.toString(16))
      // add nonce debugging information to txMeta
      txMeta.nonceDetails = nonceLock.nonceDetails
      if (customNonceValue === 0 || customNonceValue) {
        txMeta.nonceDetails.customNonceValue = customNonceValue
      }
      this.txStateManager.updateTx(txMeta, 'transactions#approveTransaction')

      // sign transaction
      await this.signTransaction(txId)
      await this.publishTransaction(txId)
      // must set transaction to submitted/failed before releasing lock
      nonceLock.releaseLock()
    } catch (err) {
      // this is try-catch wrapped so that we can guarantee that the nonceLock is released
      try {
        this.txStateManager.setTxStatusFailed(txId, err)
      } catch (err) {
        log.error(err)
      }
      // must set transaction to submitted/failed before releasing lock
      if (nonceLock) {
        nonceLock.releaseLock()
      }
      // continue with error chain
      throw err
    } finally {
      this.inProcessOfSigning.delete(txId)
    }
  }

  /**
    adds the chain id and signs the transaction and set the status to signed
    @param {number} txId - the tx's Id
    @returns {string} - rawTx
  */
  async signTransaction(txId) {
    const txMeta = this.txStateManager.getTx(txId)
    const txParams = Object.assign({}, txMeta.txParams)
    txParams.storageLimit = txParams.storageLimit || '0x0'
    // sign tx
    const fromAddress = txParams.from
    const ethTx = new Transaction(txParams)
    await this.signEthTx(ethTx, fromAddress, {
      networkId: parseInt(txMeta.metamaskNetworkId, 10),
    })

    // add r,s,v values for provider request purposes see createMetamaskMiddleware
    // and JSON rpc standard for further explanation
    txMeta.r = ethUtil.bufferToHex(ethTx.r)
    txMeta.s = ethUtil.bufferToHex(ethTx.s)
    txMeta.v = ethUtil.bufferToHex(ethTx.v)
    const rawTx = ethUtil.bufferToHex(ethTx.serialize())
    txMeta.rawTx = rawTx

    this.txStateManager.updateTx(
      txMeta,
      'transactions#signTransaction: add r, s, v, rawTx values'
    )

    // set state to signed
    this.txStateManager.setTxStatusSigned(txMeta.id)
    return rawTx
  }

  /**
    publishes the raw tx and sets the txMeta to submitted
    @param {number} txId - the tx's Id
    @param {string} rawTx - the hex string of the serialized signed transaction
    @returns {Promise<void>}
  */
  async publishTransaction(txId) {
    const txMeta = this.txStateManager.getTx(txId)
    this.txStateManager.updateTx(txMeta, 'transactions#publishTransaction')
    let txHash
    try {
      txHash = await this.query.sendRawTransaction(txMeta.rawTx)
    } catch (error) {
      if (error.message.toLowerCase().includes('tx already exist')) {
        txHash = ethUtil
          .keccak(ethUtil.addHexPrefix(txMeta.rawTx))
          .toString('hex')
        txHash = ethUtil.addHexPrefix(txHash)
      } else {
        throw error
      }
    }
    this.setTxHash(txId, txHash)

    this.txStateManager.setTxStatusSubmitted(txId)
  }

  /**
   * Sets the status of the transaction to confirmed and sets the status of nonce duplicates as
   * dropped if the txParams have data it will fetch the txReceipt
   * @param {number} txId - The tx's ID
   * @returns {Promise<void>}
   */
  async confirmTransaction(txId, txReceipt, executedOnly) {
    // get the txReceipt before marking the transaction confirmed
    // to ensure the receipt is gotten before the ui revives the tx
    const txMeta = this.txStateManager.getTx(txId)

    if (!txMeta) {
      return
    }

    if (txMeta.status === 'executed' && executedOnly) {
      return
    }

    if (txMeta.status === 'executed' && !executedOnly) {
      this.txStateManager.setTxStatusConfirmed(txId)
      this._markNonceDuplicatesDropped(txId)
    }
    if (txMeta.status !== 'executed' && executedOnly) {
      try {
        // It seems that sometimes the numerical values being returned from
        // this.query.getTransactionReceipt are BN instances and not strings.
        const gasUsed =
          typeof txReceipt.gasUsed !== 'string'
            ? txReceipt.gasUsed.toString(16)
            : txReceipt.gasUsed

        txMeta.txReceipt = {
          ...txReceipt,
          gasUsed,
        }

        this.txStateManager.updateTx(
          txMeta,
          'transactions#confirmTransaction - add txReceipt'
        )
      } catch (err) {
        log.error(err)
      }
      this.txStateManager._setTxStatus(txId, 'executed')
    }
  }

  /**
    Convenience method for the ui thats sets the transaction to rejected
    @param {number} txId - the tx's Id
    @returns {Promise<void>}
  */
  async cancelTransaction(txId) {
    this.txStateManager.setTxStatusRejected(txId)
  }

  /**
    Sets the txHas on the txMeta
    @param {number} txId - the tx's Id
    @param {string} txHash - the hash for the txMeta
  */
  setTxHash(txId, txHash) {
    // Add the tx hash to the persisted meta-tx object
    const txMeta = this.txStateManager.getTx(txId)
    txMeta.hash = txHash
    this.txStateManager.updateTx(txMeta, 'transactions#setTxHash')
  }

  //
  //           PRIVATE METHODS
  //
  /** maps methods for convenience*/
  _mapMethods() {
    /** @returns {Object} - the state in transaction controller */
    this.getState = () => this.memStore.getState()
    /** @returns {string|number} - the network number stored in networkStore */
    this.getNetwork = () => this.networkStore.getState()
    /** @returns {string} - the user selected address */
    this.getSelectedAddress = () =>
      this.preferencesStore.getState().selectedAddress
    /** @returns {array} - transactions whos status is unapproved */
    this.getUnapprovedTxCount = () =>
      Object.keys(this.txStateManager.getUnapprovedTxList()).length
    /**
      @returns {number} - number of transactions that have the status submitted
      @param {string} account - hex prefixed account
    */
    this.getPendingTxCount = account =>
      this.txStateManager.getPendingTransactions(account).length
    /** see txStateManager */
    this.getFilteredTxList = opts => this.txStateManager.getFilteredTxList(opts)
  }

  // called once on startup
  async _updatePendingTxsAfterFirstBlock() {
    // wait for first block so we know we're ready
    await this.blockTracker.getLatestBlock()
    // get status update for all pending transactions (for the current network)
    await this.pendingTxTracker.updatePendingTxs()
  }

  /**
    If transaction controller was rebooted with transactions that are uncompleted
    in steps of the transaction signing or user confirmation process it will either
    transition txMetas to a failed state or try to redo those tasks.
  */

  _onBootCleanUp() {
    this.txStateManager
      .getFilteredTxList({
        status: 'unapproved',
        loadingDefaults: true,
      })
      .forEach(tx => {
        this.addTxGasAndCollateralDefaults(tx)
          .then(txMeta => {
            txMeta.loadingDefaults = false
            return this.addTxSponsorshipInfo(txMeta)
          })
          .then(txMeta => {
            this.txStateManager.updateTx(
              txMeta,
              'transactions: gas estimation for tx on boot'
            )
          })
          .catch(error => {
            tx.loadingDefaults = false
            this.txStateManager.updateTx(
              tx,
              'failed to estimate gas during boot cleanup.'
            )
            this.txStateManager.setTxStatusFailed(tx.id, error)
          })
      })

    this.txStateManager
      .getFilteredTxList({
        status: TRANSACTION_STATUS_APPROVED,
      })
      .forEach(txMeta => {
        const txSignError = new Error(
          'Transaction found as "approved" during boot - possibly stuck during signing'
        )
        this.txStateManager.setTxStatusFailed(txMeta.id, txSignError)
      })
  }

  /**
    is called in constructor applies the listeners for pendingTxTracker txStateManager
    and blockTracker
  */
  _setupListeners() {
    this.txStateManager.on(
      'tx:status-update',
      this.emit.bind(this, 'tx:status-update')
    )
    this._setupBlockTrackerListener()
    this.pendingTxTracker.on('tx:warning', txMeta => {
      this.txStateManager.updateTx(
        txMeta,
        'transactions/pending-tx-tracker#event: tx:warning'
      )
    })
    this.pendingTxTracker.on('tx:executed', (txId, transactionReceipt) =>
      this.confirmTransaction(txId, transactionReceipt, true)
    )
    this.pendingTxTracker.on(
      'tx:failed',
      this.txStateManager.setTxStatusFailed.bind(this.txStateManager)
    )
    this.pendingTxTracker.on(
      'tx:skipped',
      this.txStateManager.setTxStatusSkipped.bind(this.txStateManager)
    )
    this.pendingTxTracker.on('tx:confirmed', txId =>
      this.confirmTransaction(txId)
    )
    this.pendingTxTracker.on(
      'tx:dropped',
      this.txStateManager.setTxStatusDropped.bind(this.txStateManager)
    )
    this.pendingTxTracker.on(
      'tx:bugged',
      this.txStateManager.setTxStatusBugged.bind(this.txStateManager)
    )
    // this.pendingTxTracker.on('tx:block-update', (txMeta, latestBlockNumber) => {
    // })
    this.pendingTxTracker.on('tx:retry', txMeta => {
      if (!('retryCount' in txMeta)) {
        txMeta.retryCount = 0
      }
      txMeta.retryCount++
      this.txStateManager.updateTx(
        txMeta,
        'transactions/pending-tx-tracker#event: tx:retry'
      )
    })
  }

  /**
    Returns a "type" for a transaction out of the following list: simpleSend, tokenTransfer, tokenApprove,
    contractDeployment, contractMethodCall
  */
  async _determineTransactionCategory(txParams) {
    const { data, to } = txParams

    // detect internal contracts
    if (
      [
        '0x0888000000000000000000000000000000000000',
        '0x0888000000000000000000000000000000000001',
        '0x0888000000000000000000000000000000000002',
      ].includes(to?.toLowerCase())
    ) {
      return {
        transactionCategory: CONTRACT_INTERACTION_KEY,
        getCodeResponse: to,
      }
    }
    const { name } = (data && abiDecoder.decodeMethod(data)) || {}
    const tokenMethodName = [
      TOKEN_METHOD_APPROVE,
      TOKEN_METHOD_TRANSFER,
      TOKEN_METHOD_TRANSFER_FROM,
    ].find(tokenMethodName => tokenMethodName === name && name.toLowerCase())

    let result
    if (txParams.data && tokenMethodName) {
      result = tokenMethodName
    } else if (txParams.data && !to) {
      result = DEPLOY_CONTRACT_ACTION_KEY
    }

    let code
    if (!result) {
      try {
        code = to.startsWith('0x1') ? null : await this.query.getCode(to)
      } catch (e) {
        code = null
        // conflux fullnode will return a error here if it's not a contract addr
        // log.warn(e)
      }

      const codeIsEmpty = !code || code === '0x' || code === '0x0'

      result = codeIsEmpty ? SEND_ETHER_ACTION_KEY : CONTRACT_INTERACTION_KEY
    }

    return { transactionCategory: result, getCodeResponse: code }
  }

  /**
    Sets other txMeta statuses to dropped if the txMeta that has been confirmed has other transactions
    in the list have the same nonce

    @param {number} txId - the txId of the transaction that has been confirmed in a block
  */
  _markNonceDuplicatesDropped(txId) {
    // get the confirmed transactions nonce and from address
    const txMeta = this.txStateManager.getTx(txId)
    const { nonce, from } = txMeta.txParams
    const sameNonceTxs = this.txStateManager.getFilteredTxList({ nonce, from })
    if (!sameNonceTxs.length) {
      return
    }
    // mark all same nonce transactions as dropped and give i a replacedBy hash
    sameNonceTxs.forEach(otherTxMeta => {
      if (otherTxMeta.id === txId) {
        return
      }
      otherTxMeta.replacedBy = txMeta.hash
      this.txStateManager.updateTx(
        txMeta,
        'transactions/pending-tx-tracker#event: tx:confirmed reference to confirmed txHash with same nonce'
      )
      this.txStateManager.setTxStatusDropped(otherTxMeta.id)
    })
  }

  _setupBlockTrackerListener() {
    let listenersAreActive = false
    const latestBlockHandler = this._onLatestBlock.bind(this)
    const blockTracker = this.blockTracker
    const txStateManager = this.txStateManager

    txStateManager.on('tx:status-update', updateSubscription)
    updateSubscription()

    function updateSubscription() {
      const pendingTxs = txStateManager.getPendingTransactions()
      if (!listenersAreActive && pendingTxs.length > 0) {
        blockTracker.on('latest', latestBlockHandler)
        listenersAreActive = true
      } else if (listenersAreActive && !pendingTxs.length) {
        blockTracker.removeListener('latest', latestBlockHandler)
        listenersAreActive = false
      }
    }
  }

  async _onLatestBlock(blockNumber) {
    try {
      await this.pendingTxTracker.updatePendingTxs()
    } catch (err) {
      log.error(err)
    }
    try {
      await this.pendingTxTracker.resubmitPendingTxs(blockNumber)
    } catch (err) {
      log.error(err)
    }
  }

  /**
    Updates the memStore in transaction controller
  */
  _updateMemstore() {
    this.pendingTxTracker.updatePendingTxs()
    const unapprovedTxs = this.txStateManager.getUnapprovedTxList()
    const selectedAddressTxList = this.txStateManager.getFilteredTxList({
      from: this.getSelectedAddress(),
      metamaskNetworkId: this.getNetwork(),
    })
    this.memStore.updateState({ unapprovedTxs, selectedAddressTxList })
  }
}

export default TransactionController
