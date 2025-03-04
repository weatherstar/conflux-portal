/**
 * @file      The central metamask controller. Aggregates other controllers and exports an api.
 * @copyright Copyright (c) 2018 MetaMask
 * @license   MIT
 */

import EventEmitter from 'events'

import pump from 'pump'
import Dnode from 'dnode'
import extension from 'extensionizer'
import ObservableStore from 'obs-store'
import ComposableObservableStore from './lib/ComposableObservableStore'
import asStream from 'obs-store/lib/asStream'
import AccountTracker from './lib/account-tracker'
import RpcEngine from 'json-rpc-engine'
import { debounce } from 'lodash'
import createEngineStream from 'json-rpc-middleware-stream/engineStream'
import createFilterMiddleware from 'eth-json-rpc-filters'
import createSubscriptionManager from 'eth-json-rpc-filters/subscriptionManager'
import createLoggerMiddleware from './lib/createLoggerMiddleware'
import createOriginMiddleware from './lib/createOriginMiddleware'
import createOnboardingMiddleware from './lib/createOnboardingMiddleware'
import providerAsMiddleware from '@yqrashawn/cfx-json-rpc-middleware/providerAsMiddleware'
import { setupMultiplex } from './lib/stream-utils.js'
import KeyringController from 'cfx-keyring-controller'
// import EnsController from './controllers/ens'
import NetworkController from './controllers/network'
import PreferencesController from './controllers/preferences'
import AppStateController from './controllers/app-state'
// import InfuraController from './controllers/infura'
import CachedBalancesController from './controllers/cached-balances'
import OnboardingController from './controllers/onboarding'
// import ThreeBoxController from './controllers/threebox'
// import RecentBlocksController from './controllers/recent-blocks'
import IncomingTransactionsController from './controllers/incoming-transactions'
import MessageManager from './lib/message-manager'
import DecryptMessageManager from './lib/decrypt-message-manager'
import EncryptionPublicKeyManager from './lib/encryption-public-key-manager'
import PersonalMessageManager from './lib/personal-message-manager'
import TypedMessageManager from './lib/typed-message-manager'
import TransactionController from './controllers/transactions'
// import TokenRatesController from './controllers/token-rates'
import DetectTokensController from './controllers/detect-tokens'
import ABTestController from './controllers/ab-test'
import { PermissionsController } from './controllers/permissions'
import nodeify from './lib/nodeify'
import accountImporter from './account-import-strategies'
import getBuyEthUrl from './lib/buy-eth-url'
import selectChainId from './lib/select-chain-id'
import { Mutex } from 'await-semaphore'
import { version } from '../manifest.json'
import { stripHexPrefix, toChecksumAddress } from 'cfx-util'

// const GWEI_BN = new BN('1000000000')
// import percentile from 'percentile'
import seedPhraseVerifier from './lib/seed-phrase-verifier'
import log from 'loglevel'
import TrezorKeyring from 'eth-trezor-keyring'
import LedgerBridgeKeyring from '@metamask/eth-ledger-bridge-keyring'
import EthQuery from './eth-query'
import { getStatus } from './controllers/network/util'

import nanoid from 'nanoid'
import {
  CurrencyRateController,
  ShapeShiftController,
  // PhishingController,
} from 'gaba'
import PhishingController from './controllers/PhishingController.js'

import { AddressBookControllerWithBase32Address } from './addressbook-cip37'

import backEndMetaMetricsEvent from './lib/backend-metametrics'

export default class MetamaskController extends EventEmitter {
  /**
   * @constructor
   * @param {Object} opts
   */
  constructor(opts) {
    super()

    this.defaultMaxListeners = 20

    this.sendUpdate = debounce(this.privateSendUpdate.bind(this), 200)
    this.opts = opts
    const initState = opts.initState || {}
    this.recordFirstTimeInfo(initState)

    // this keeps track of how many "controllerStream" connections are open
    // the only thing that uses controller connections are open metamask UI instances
    this.activeControllerConnections = 0

    // platform-specific api
    this.platform = opts.platform

    this.getRequestAccountTabIds = opts.getRequestAccountTabIds
    this.getOpenMetamaskTabsIds = opts.getOpenMetamaskTabsIds

    // observable state store
    this.store = new ComposableObservableStore(initState)

    // external connections by origin
    // Do not modify directly. Use the associated methods.
    this.connections = {}

    // lock to ensure only one vault created at once
    this.createVaultMutex = new Mutex()

    // next, we will initialize the controllers
    // controller initializaiton order matters

    this.networkController = new NetworkController(initState.NetworkController)

    this.preferencesController = new PreferencesController({
      initState: initState.PreferencesController,
      initLangCode: opts.initLangCode,
      openPopup: opts.openPopup,
      network: this.networkController,
    })

    this.appStateController = new AppStateController({
      preferencesStore: this.preferencesController.store,
      onInactiveTimeout: () => this.setLocked(),
      initState: initState.AppStateController,
    })

    this.currencyRateController = new CurrencyRateController(
      undefined,
      initState.CurrencyController
    )

    // this.infuraController = new InfuraController({
    //   initState: initState.InfuraController,
    // })
    // this.infuraController.scheduleInfuraNetworkCheck()

    this.phishingController = new PhishingController()

    // now we can initialize the RPC provider, which other controllers require
    this.initializeProvider()
    this.provider = this.networkController.getProviderAndBlockTracker().provider
    this.blockTracker = this.networkController.getProviderAndBlockTracker().blockTracker

    // token exchange rate tracker
    // this.tokenRatesController = new TokenRatesController({
    //   currency: this.currencyRateController,
    //   preferences: this.preferencesController.store,
    // })

    // this.ensController = new EnsController({
    //   provider: this.provider,
    //   networkStore: this.networkController.networkStore,
    // })

    this.incomingTransactionsController = new IncomingTransactionsController({
      blockTracker: this.blockTracker,
      networkController: this.networkController,
      preferencesController: this.preferencesController,
      initState: initState.IncomingTransactionsController,
    })

    // account tracker watches balances, nonces, and any code at their address
    this.accountTracker = new AccountTracker({
      provider: this.provider,
      blockTracker: this.blockTracker,
      network: this.networkController,
    })

    // start and stop polling for balances based on activeControllerConnections
    this.on('controllerConnectionChanged', activeControllerConnections => {
      if (activeControllerConnections > 0) {
        this.accountTracker.start()
        this.incomingTransactionsController.start()
      } else {
        this.accountTracker.stop()
        this.incomingTransactionsController.stop()
      }
    })

    this.cachedBalancesController = new CachedBalancesController({
      accountTracker: this.accountTracker,
      getNetwork: this.networkController.getNetworkState.bind(
        this.networkController
      ),
      initState: initState.CachedBalancesController,
    })

    this.onboardingController = new OnboardingController({
      initState: initState.OnboardingController,
      preferencesController: this.preferencesController,
    })

    // ensure accountTracker updates balances after network change
    this.networkController.on('networkDidChange', () => {
      this.accountTracker._updateAccounts()
    })

    const additionalKeyrings = [TrezorKeyring, LedgerBridgeKeyring]
    this.keyringController = new KeyringController({
      keyringTypes: additionalKeyrings,
      initState: initState.KeyringController,
      getNetwork: this.networkController.getNetworkState.bind(
        this.networkController
      ),
      encryptor: opts.encryptor || undefined,
    })
    this.keyringController.memStore.subscribe(s =>
      this._onKeyringControllerUpdate(s)
    )

    this.permissionsController = new PermissionsController(
      {
        getCurrentNetwork: this.getCurrentNetwork.bind(this),
        getKeyringAccounts: this.keyringController.getAccounts.bind(
          this.keyringController
        ),
        notifyDomain: this.notifyConnections.bind(this),
        notifyAllDomains: this.notifyAllConnections.bind(this),
        showPermissionRequest: opts.showUserConfirmation,
      },
      initState.PermissionsController,
      initState.PermissionsMetadata
    )

    this.detectTokensController = new DetectTokensController({
      preferences: this.preferencesController,
      network: this.networkController,
      keyringMemStore: this.keyringController.memStore,
    })

    this.abTestController = new ABTestController({
      initState: initState.ABTestController,
    })

    this.addressBookController = new AddressBookControllerWithBase32Address(
      undefined,
      initState.AddressBookController
    )

    // this.threeBoxController = new ThreeBoxController({
    //   preferencesController: this.preferencesController,
    //   addressBookController: this.addressBookController,
    //   keyringController: this.keyringController,
    //   initState: initState.ThreeBoxController,
    //   getKeyringControllerState: this.keyringController.memStore.getState.bind(
    //     this.keyringController.memStore
    //   ),
    //   version,
    // })

    this.txController = new TransactionController({
      initState:
        initState.TransactionController || initState.TransactionManager,
      getPermittedAccounts: this.permissionsController.getAccounts.bind(
        this.permissionsController
      ),
      networkStore: this.networkController.networkStore,
      preferencesStore: this.preferencesController.store,
      txHistoryLimit: 100,
      getNetwork: this.networkController.getNetworkState.bind(this),
      signTransaction: this.keyringController.signTransaction.bind(
        this.keyringController
      ),
      provider: this.provider,
      blockTracker: this.blockTracker,
      getGasPrice: this.getGasPrice.bind(this),
    })
    this.txController.on('newUnapprovedTx', () => opts.showUnapprovedTx())

    this.txController.on(`tx:status-update`, async (txId, status) => {
      if (status === 'confirmed' || status === 'failed') {
        const txMeta = this.txController.txStateManager.getTx(txId)
        this.platform.showTransactionNotification(txMeta)

        const { txReceipt } = txMeta
        const participateInMetaMetrics = this.preferencesController.getParticipateInMetaMetrics()
        if (
          txReceipt &&
          txReceipt.status === '0x0' &&
          participateInMetaMetrics
        ) {
          const metamaskState = await this.getState()
          backEndMetaMetricsEvent(metamaskState, {
            customVariables: {
              errorMessage: txMeta.simulationFails?.reason,
            },
            eventOpts: {
              category: 'backend',
              action: 'Transactions',
              name: 'On Chain Failure',
            },
          })
        }
      }
    })

    this.networkController.on('networkDidChange', () => {
      this.setCurrentCurrency(
        this.currencyRateController.state.currentCurrency,
        function() {}
      )
    })

    this.shapeshiftController = new ShapeShiftController(
      undefined,
      initState.ShapeShiftController
    )

    this.networkController.lookupNetwork()
    this.messageManager = new MessageManager()
    this.personalMessageManager = new PersonalMessageManager()
    this.decryptMessageManager = new DecryptMessageManager()
    this.encryptionPublicKeyManager = new EncryptionPublicKeyManager()
    this.typedMessageManager = new TypedMessageManager({
      networkController: this.networkController,
    })

    // ensure isClientOpenAndUnlocked is updated when memState updates
    this.on('update', memState => {
      this.isClientOpenAndUnlocked = memState.isUnlocked && this._isClientOpen
    })

    this.store.updateStructure({
      AppStateController: this.appStateController.store,
      TransactionController: this.txController.store,
      KeyringController: this.keyringController.store,
      PreferencesController: this.preferencesController.store,
      AddressBookController: this.addressBookController,
      CurrencyController: this.currencyRateController,
      ShapeShiftController: this.shapeshiftController,
      NetworkController: this.networkController.store,
      // InfuraController: this.infuraController.store,
      CachedBalancesController: this.cachedBalancesController.store,
      OnboardingController: this.onboardingController.store,
      IncomingTransactionsController: this.incomingTransactionsController.store,
      ABTestController: this.abTestController.store,
      PermissionsController: this.permissionsController.permissions,
      PermissionsMetadata: this.permissionsController.store,
      // ThreeBoxController: this.threeBoxController.store,
    })

    this.memStore = new ComposableObservableStore(null, {
      AppStateController: this.appStateController.store,
      NetworkController: this.networkController.store,
      AccountTracker: this.accountTracker.store,
      TxController: this.txController.memStore,
      CachedBalancesController: this.cachedBalancesController.store,
      // TokenRatesController: this.tokenRatesController.store,
      MessageManager: this.messageManager.memStore,
      PersonalMessageManager: this.personalMessageManager.memStore,
      DecryptMessageManager: this.decryptMessageManager.memStore,
      EncryptionPublicKeyManager: this.encryptionPublicKeyManager.memStore,
      TypesMessageManager: this.typedMessageManager.memStore,
      KeyringController: this.keyringController.memStore,
      PreferencesController: this.preferencesController.store,
      AddressBookController: this.addressBookController,
      CurrencyController: this.currencyRateController,
      ShapeshiftController: this.shapeshiftController,
      // InfuraController: this.infuraController.store,
      OnboardingController: this.onboardingController.store,
      IncomingTransactionsController: this.incomingTransactionsController.store,
      PermissionsController: this.permissionsController.permissions,
      PermissionsMetadata: this.permissionsController.store,
      // ThreeBoxController: this.threeBoxController.store,
      ABTestController: this.abTestController.store,
      // ENS Controller
      // EnsController: this.ensController.store,
    })
    this.memStore.subscribe(this.sendUpdate.bind(this))
  }

  /**
   * Constructor helper: initialize a provider.
   */
  initializeProvider() {
    const providerOpts = {
      static: {
        eth_syncing: false,
        web3_clientVersion: `MetaMask/v${version}`,
      },
      version,
      // account mgmt
      getAccounts: async ({ origin }) => {
        if (origin === 'metamask') {
          const selectedAddress = this.preferencesController.getSelectedAddress()
          return selectedAddress ? [selectedAddress] : []
        } else if (this.keyringController.memStore.getState().isUnlocked) {
          return await this.permissionsController.getAccounts(origin)
        }
        return [] // changing this is a breaking change
      },
      // tx signing
      processTransaction: this.newUnapprovedTransaction.bind(this),
      // msg signing
      processEthSignMessage: this.newUnsignedMessage.bind(this),
      processTypedMessage: this.newUnsignedTypedMessage.bind(this),
      processTypedMessageV3: this.newUnsignedTypedMessage.bind(this),
      processTypedMessageV4: this.newUnsignedTypedMessage.bind(this),
      processPersonalMessage: this.newUnsignedPersonalMessage.bind(this),
      processDecryptMessage: this.newRequestDecryptMessage.bind(this),
      processEncryptionPublicKey: this.newRequestEncryptionPublicKey.bind(this),
      getPendingNonce: this.getPendingNonce.bind(this),
      getPendingTransactionByHash: hash =>
        this.txController.getFilteredTxList({ hash, status: 'submitted' })[0],
    }
    const providerProxy = this.networkController.initializeProvider(
      providerOpts
    )
    return providerProxy
  }

  /**
   * Constructor helper: initialize a public config store.
   * This store is used to make some config info available to Dapps synchronously.
   */
  createPublicConfigStore() {
    // subset of state for metamask inpage provider
    const publicConfigStore = new ObservableStore()

    // setup memStore subscription hooks
    this.on('update', updatePublicConfigStore)
    updatePublicConfigStore(this.getState())

    publicConfigStore.destroy = () => {
      this.removeEventListener &&
        this.removeEventListener('update', updatePublicConfigStore)
    }

    function updatePublicConfigStore(memState) {
      publicConfigStore.putState(selectPublicState(memState))
    }

    function selectPublicState({ isUnlocked, network, provider }) {
      return {
        isUnlocked,
        networkVersion: network,
        chainId: selectChainId({ network, provider }),
      }
    }
    return publicConfigStore
  }

  //=============================================================================
  // EXPOSED TO THE UI SUBSYSTEM
  //=============================================================================

  /**
   * The metamask-state of the various controllers, made available to the UI
   *
   * @returns {Object} - status
   */
  getState() {
    const vault = this.keyringController.store.getState().vault
    const isInitialized = !!vault
    return {
      ...{ isInitialized },
      ...this.memStore.getFlatState(),
    }
  }

  /**
   * Returns an Object containing API Callback Functions.
   * These functions are the interface for the UI.
   * The API object can be transmitted over a stream with dnode.
   *
   * @returns {Object} - Object containing API functions.
   */
  getApi() {
    const keyringController = this.keyringController
    const networkController = this.networkController
    const onboardingController = this.onboardingController
    const permissionsController = this.permissionsController
    const preferencesController = this.preferencesController
    // const threeBoxController = this.threeBoxController
    const abTestController = this.abTestController
    const txController = this.txController

    return {
      // etc
      getState: cb => cb(null, this.getState()),
      setCurrentCurrency: this.setCurrentCurrency.bind(this),
      setUseBlockie: this.setUseBlockie.bind(this),
      setUseNonceField: this.setUseNonceField.bind(this),
      setIpfsGateway: this.setIpfsGateway.bind(this),
      setParticipateInMetaMetrics: this.setParticipateInMetaMetrics.bind(this),
      setMetaMetricsSendCount: this.setMetaMetricsSendCount.bind(this),
      setFirstTimeFlowType: this.setFirstTimeFlowType.bind(this),
      setCurrentLocale: this.setCurrentLocale.bind(this),
      markPasswordForgotten: this.markPasswordForgotten.bind(this),
      unMarkPasswordForgotten: this.unMarkPasswordForgotten.bind(this),
      getGasPrice: cb => cb(null, this.getGasPrice()),

      // coinbase
      buyEth: this.buyEth.bind(this),

      // primary HD keyring management
      addNewAccount: nodeify(this.addNewAccount, this),
      verifySeedPhrase: nodeify(this.verifySeedPhrase, this),
      resetAccount: nodeify(this.resetAccount, this),
      removeAccount: nodeify(this.removeAccount, this),
      importAccountWithStrategy: nodeify(this.importAccountWithStrategy, this),

      // hardware wallets
      connectHardware: nodeify(this.connectHardware, this),
      forgetDevice: nodeify(this.forgetDevice, this),
      checkHardwareStatus: nodeify(this.checkHardwareStatus, this),
      unlockHardwareWalletAccount: nodeify(
        this.unlockHardwareWalletAccount,
        this
      ),

      // mobile
      fetchInfoToSync: nodeify(this.fetchInfoToSync, this),

      // vault management
      submitPassword: nodeify(this.submitPassword, this),

      // network management
      setProviderType: nodeify(
        networkController.setProviderType,
        networkController
      ),
      setCustomRpc: nodeify(this.setCustomRpc, this),
      updateAndSetCustomRpc: nodeify(this.updateAndSetCustomRpc, this),
      delCustomRpc: nodeify(this.delCustomRpc, this),

      // PreferencesController
      setSelectedAddress: nodeify(
        preferencesController.setSelectedAddress,
        preferencesController
      ),
      addToken: nodeify(preferencesController.addToken, preferencesController),
      removeToken: nodeify(
        preferencesController.removeToken,
        preferencesController
      ),
      removeSuggestedTokens: nodeify(
        preferencesController.removeSuggestedTokens,
        preferencesController
      ),
      setCurrentAccountTab: nodeify(
        preferencesController.setCurrentAccountTab,
        preferencesController
      ),
      setAccountLabel: nodeify(
        preferencesController.setAccountLabel,
        preferencesController
      ),
      setFeatureFlag: nodeify(
        preferencesController.setFeatureFlag,
        preferencesController
      ),
      setPreference: nodeify(
        preferencesController.setPreference,
        preferencesController
      ),
      completeOnboarding: nodeify(
        preferencesController.completeOnboarding,
        preferencesController
      ),
      addKnownMethodData: nodeify(
        preferencesController.addKnownMethodData,
        preferencesController
      ),
      clearLastSelectedAddressHistory: nodeify(
        preferencesController.clearLastSelectedAddressHistory,
        preferencesController
      ),
      removeLastSelectedAddressesFor: nodeify(
        preferencesController.removeLastSelectedAddressesFor,
        preferencesController
      ),

      // BlacklistController
      whitelistPhishingDomain: this.whitelistPhishingDomain.bind(this),

      // AddressController
      setAddressBook: nodeify(
        this.addressBookController.set,
        this.addressBookController
      ),
      removeFromAddressBook: this.addressBookController.delete.bind(
        this.addressBookController
      ),

      // AppStateController
      setLastActiveTime: nodeify(
        this.appStateController.setLastActiveTime,
        this.appStateController
      ),
      setMkrMigrationReminderTimestamp: nodeify(
        this.appStateController.setMkrMigrationReminderTimestamp,
        this.appStateController
      ),

      // // EnsController
      // tryReverseResolveAddress: nodeify(
      //   this.ensController.reverseResolveAddress,
      //   this.ensController
      // ),

      // KeyringController
      setLocked: nodeify(this.setLocked, this),
      createNewVaultAndKeychain: nodeify(this.createNewVaultAndKeychain, this),
      createNewVaultAndRestore: nodeify(this.createNewVaultAndRestore, this),
      addNewKeyring: nodeify(
        keyringController.addNewKeyring,
        keyringController
      ),
      exportAccount: nodeify(
        keyringController.exportAccount,
        keyringController
      ),

      // txController
      addTxSponsorshipInfo: nodeify(
        txController.addTxSponsorshipInfo,
        txController
      ),
      cancelTransaction: nodeify(txController.cancelTransaction, txController),
      updateTransaction: nodeify(txController.updateTransaction, txController),
      updateAndApproveTransaction: nodeify(
        txController.updateAndApproveTransaction,
        txController
      ),
      retryTransaction: nodeify(this.retryTransaction, this),
      createCancelTransaction: nodeify(this.createCancelTransaction, this),
      createSpeedUpTransaction: nodeify(this.createSpeedUpTransaction, this),
      getFilteredTxList: nodeify(txController.getFilteredTxList, txController),
      isNonceTaken: nodeify(txController.isNonceTaken, txController),
      estimateGas: nodeify(this.estimateGas, this),
      checkBalanceAgainstTransaction: nodeify(
        this.checkBalanceAgainstTransaction,
        this
      ),
      getPendingNonce: nodeify(this.getPendingNonce, this),
      getNextNonce: nodeify(this.getNextNonce, this),

      // messageManager
      signMessage: nodeify(this.signMessage, this),
      cancelMessage: this.cancelMessage.bind(this),

      // personalMessageManager
      signPersonalMessage: nodeify(this.signPersonalMessage, this),
      cancelPersonalMessage: this.cancelPersonalMessage.bind(this),

      // personalMessageManager
      signTypedMessage: nodeify(this.signTypedMessage, this),
      cancelTypedMessage: this.cancelTypedMessage.bind(this),

      // decryptMessageManager
      decryptMessage: nodeify(this.decryptMessage, this),
      decryptMessageInline: nodeify(this.decryptMessageInline, this),
      cancelDecryptMessage: this.cancelDecryptMessage.bind(this),

      // EncryptionPublicKeyManager
      encryptionPublicKey: nodeify(this.encryptionPublicKey, this),
      cancelEncryptionPublicKey: this.cancelEncryptionPublicKey.bind(this),

      // onboarding controller
      setSeedPhraseBackedUp: nodeify(
        onboardingController.setSeedPhraseBackedUp,
        onboardingController
      ),

      // 3Box
      // setThreeBoxSyncingPermission: nodeify(
      //   threeBoxController.setThreeBoxSyncingPermission,
      //   threeBoxController
      // ),
      // restoreFromThreeBox: nodeify(
      //   threeBoxController.restoreFromThreeBox,
      //   threeBoxController
      // ),
      // setShowRestorePromptToFalse: nodeify(
      //   threeBoxController.setShowRestorePromptToFalse,
      //   threeBoxController
      // ),
      // getThreeBoxLastUpdated: nodeify(
      //   threeBoxController.getLastUpdated,
      //   threeBoxController
      // ),
      // turnThreeBoxSyncingOn: nodeify(
      //   threeBoxController.turnThreeBoxSyncingOn,
      //   threeBoxController
      // ),
      // initializeThreeBox: nodeify(this.initializeThreeBox, this),

      // a/b test controller
      getAssignedABTestGroupName: nodeify(
        abTestController.getAssignedABTestGroupName,
        abTestController
      ),

      // permissions
      approvePermissionsRequest: nodeify(
        permissionsController.approvePermissionsRequest,
        permissionsController
      ),
      clearPermissions: permissionsController.clearPermissions.bind(
        permissionsController
      ),
      getApprovedAccounts: nodeify(
        permissionsController.getAccounts.bind(permissionsController)
      ),
      rejectPermissionsRequest: nodeify(
        permissionsController.rejectPermissionsRequest,
        permissionsController
      ),
      removePermissionsFor: permissionsController.removePermissionsFor.bind(
        permissionsController
      ),
      updatePermittedAccounts: nodeify(
        permissionsController.updatePermittedAccounts,
        permissionsController
      ),
      legacyExposeAccounts: nodeify(
        permissionsController.legacyExposeAccounts,
        permissionsController
      ),
      handleNewAccountSelected: nodeify(this.handleNewAccountSelected, this),

      getRequestAccountTabIds: cb => cb(null, this.getRequestAccountTabIds()),
      getOpenMetamaskTabsIds: cb => cb(null, this.getOpenMetamaskTabsIds()),
    }
  }

  //=============================================================================
  // VAULT / KEYRING RELATED METHODS
  //=============================================================================

  /**
   * Creates a new Vault and create a new keychain.
   *
   * A vault, or KeyringController, is a controller that contains
   * many different account strategies, currently called Keyrings.
   * Creating it new means wiping all previous keyrings.
   *
   * A keychain, or keyring, controls many accounts with a single backup and signing strategy.
   * For example, a mnemonic phrase can generate many accounts, and is a keyring.
   *
   * @param  {string} password
   *
   * @returns {Object} - vault
   */
  async createNewVaultAndKeychain(password) {
    const releaseLock = await this.createVaultMutex.acquire()
    try {
      let vault
      const accounts = await this.keyringController.getAccounts()
      if (accounts.length > 0) {
        vault = await this.keyringController.fullUpdate()
      } else {
        vault = await this.keyringController.createNewVaultAndKeychain(password)
        const accounts = await this.keyringController.getAccounts()
        this.preferencesController.setAddresses(accounts)
        this.selectFirstIdentity()
      }
      releaseLock()
      return vault
    } catch (err) {
      releaseLock()
      throw err
    }
  }

  /**
   * Create a new Vault and restore an existent keyring.
   * @param  {} password
   * @param  {} seed
   */
  async createNewVaultAndRestore(password, seed) {
    const releaseLock = await this.createVaultMutex.acquire()
    try {
      let accounts, lastBalance

      const keyringController = this.keyringController

      // clear known identities
      this.preferencesController.setAddresses([])
      // create new vault
      const vault = await keyringController.createNewVaultAndRestore(
        password,
        seed
      )

      const ethQuery = new EthQuery(this.provider)
      accounts = await keyringController.getAccounts()
      lastBalance = await this.getBalance(
        accounts[accounts.length - 1],
        ethQuery
      )

      const primaryKeyring = keyringController.getKeyringsByType(
        'HD Key Tree'
      )[0]
      if (!primaryKeyring) {
        throw new Error('MetamaskController - No HD Key Tree found')
      }

      // seek out the first zero balance
      while (lastBalance !== '0x0') {
        await keyringController.addNewAccount(primaryKeyring)
        accounts = await keyringController.getAccounts()
        lastBalance = await this.getBalance(
          accounts[accounts.length - 1],
          ethQuery
        )
      }

      // set new identities
      this.preferencesController.setAddresses(accounts)
      this.selectFirstIdentity()
      releaseLock()
      return vault
    } catch (err) {
      releaseLock()
      throw err
    }
  }

  /**
   * Get an account balance from the AccountTracker or request it directly from the network.
   * @param {string} address - The account address
   * @param {EthQuery} ethQuery - The EthQuery instance to use when asking the network
   */
  getBalance(address, ethQuery) {
    return new Promise((resolve, reject) => {
      const cached = this.accountTracker.store.getState().accounts[address]

      if (cached && cached.balance) {
        resolve(cached.balance)
      } else {
        ethQuery.getBalance(address, (error, balance) => {
          if (error) {
            reject(error)
            log.error(error)
          } else {
            resolve(balance || '0x0')
          }
        })
      }
    })
  }

  getCurrentNetwork = () => {
    return this.networkController.store.getState().network
  }

  /**
   * Collects all the information that we want to share
   * with the mobile client for syncing purposes
   * @returns {Promise<Object>} - Parts of the state that we want to syncx
   */
  async fetchInfoToSync() {
    // Preferences
    const {
      accountTokens,
      currentLocale,
      frequentRpcList,
      identities,
      selectedAddress,
      tokens,
      trustedTokenMap = {},
    } = this.preferencesController.store.getState()

    // Filter ERC20 tokens
    const filteredAccountTokens = {}
    Object.keys(accountTokens).forEach(address => {
      const checksummedAddress = toChecksumAddress(address)
      filteredAccountTokens[checksummedAddress] = {}
      Object.keys(accountTokens[address]).forEach(
        networkType =>
          (filteredAccountTokens[checksummedAddress][networkType] =
            networkType !== 'mainnet'
              ? accountTokens[address][networkType]
              : accountTokens[address][networkType].filter(({ address }) => {
                  const tokenAddress = toChecksumAddress(address)
                  return trustedTokenMap[tokenAddress]
                    ? trustedTokenMap[tokenAddress].erc20
                    : true
                }))
      )
    })

    const preferences = {
      accountTokens: filteredAccountTokens,
      currentLocale,
      frequentRpcList,
      identities,
      selectedAddress,
      tokens,
    }

    // Accounts
    const hdKeyring = this.keyringController.getKeyringsByType('HD Key Tree')[0]
    const hdAccounts = await hdKeyring.getAccounts()
    const accounts = {
      hd: hdAccounts
        .filter((item, pos) => hdAccounts.indexOf(item) === pos)
        .map(address => toChecksumAddress(address)),
      simpleKeyPair: [],
      ledger: [],
      trezor: [],
    }

    // transactions

    let transactions = this.txController.store.getState().transactions
    // delete tx for other accounts that we're not importing
    transactions = transactions.filter(tx => {
      const checksummedTxFrom = toChecksumAddress(tx.txParams.from)
      return accounts.hd.includes(checksummedTxFrom)
    })

    return {
      accounts,
      preferences,
      transactions,
      network: this.networkController.store.getState(),
    }
  }

  /*
   * Submits the user's password and attempts to unlock the vault.
   * Also synchronizes the preferencesController, to ensure its schema
   * is up to date with known accounts once the vault is decrypted.
   *
   * @param {string} password - The user's password
   * @returns {Promise<object>} - The keyringController update.
   */
  async submitPassword(password) {
    await this.keyringController.submitPassword(password)
    const accounts = await this.keyringController.getAccounts()

    // verify keyrings
    const nonSimpleKeyrings = this.keyringController.keyrings.filter(
      keyring => keyring.type !== 'Simple Key Pair'
    )
    if (nonSimpleKeyrings.length > 1 && this.diagnostics) {
      await this.diagnostics.reportMultipleKeyrings(nonSimpleKeyrings)
    }

    await this.preferencesController.syncAddresses(accounts)
    await this.txController.pendingTxTracker.updatePendingTxs()

    // try {
    //   const threeBoxSyncingAllowed = this.threeBoxController.getThreeBoxSyncingState()
    //   if (threeBoxSyncingAllowed && !this.threeBoxController.box) {
    //     // 'await' intentionally omitted to avoid waiting for initialization
    //     this.threeBoxController.init()
    //     this.threeBoxController.turnThreeBoxSyncingOn()
    //   } else if (threeBoxSyncingAllowed && this.threeBoxController.box) {
    //     this.threeBoxController.turnThreeBoxSyncingOn()
    //   }
    // } catch (error) {
    //   log.error(error)
    // }

    return this.keyringController.fullUpdate()
  }

  /**
   * @type Identity
   * @property {string} name - The account nickname.
   * @property {string} address - The account's ethereum address, in lower case.
   * @property {boolean} mayBeFauceting - Whether this account is currently
   * receiving funds from our automatic Ropsten faucet.
   */

  /**
   * Sets the first address in the state to the selected address
   */
  selectFirstIdentity() {
    const { identities } = this.preferencesController.store.getState()
    const address = Object.keys(identities)[0]
    this.preferencesController.setSelectedAddress(address)
  }

  //
  // Hardware
  //

  async getKeyringForDevice(deviceName, hdPath = null) {
    let keyringName = null
    switch (deviceName) {
      case 'trezor':
        keyringName = TrezorKeyring.type
        break
      case 'ledger':
        keyringName = LedgerBridgeKeyring.type
        break
      default:
        throw new Error(
          'MetamaskController:getKeyringForDevice - Unknown device'
        )
    }
    let keyring = await this.keyringController.getKeyringsByType(keyringName)[0]
    if (!keyring) {
      keyring = await this.keyringController.addNewKeyring(keyringName)
    }
    if (hdPath && keyring.setHdPath) {
      keyring.setHdPath(hdPath)
    }

    keyring.network = this.networkController.getProviderConfig().type

    return keyring
  }

  /**
   * Fetch account list from a trezor device.
   *
   * @returns [] accounts
   */
  async connectHardware(deviceName, page, hdPath) {
    const keyring = await this.getKeyringForDevice(deviceName, hdPath)
    let accounts = []
    switch (page) {
      case -1:
        accounts = await keyring.getPreviousPage()
        break
      case 1:
        accounts = await keyring.getNextPage()
        break
      default:
        accounts = await keyring.getFirstPage()
    }

    // Merge with existing accounts
    // and make sure addresses are not repeated
    const oldAccounts = await this.keyringController.getAccounts()
    const accountsToTrack = [
      ...new Set(
        oldAccounts.concat(accounts.map(a => a.address.toLowerCase()))
      ),
    ]
    this.accountTracker.syncWithAddresses(accountsToTrack)
    return accounts
  }

  /**
   * Check if the device is unlocked
   *
   * @returns {Promise<boolean>}
   */
  async checkHardwareStatus(deviceName, hdPath) {
    const keyring = await this.getKeyringForDevice(deviceName, hdPath)
    return keyring.isUnlocked()
  }

  /**
   * Clear
   *
   * @returns {Promise<boolean>}
   */
  async forgetDevice(deviceName) {
    const keyring = await this.getKeyringForDevice(deviceName)
    keyring.forgetDevice()
    return true
  }

  /**
   * Imports an account from a trezor device.
   *
   * @returns {} keyState
   */
  async unlockHardwareWalletAccount(index, deviceName, hdPath) {
    const keyring = await this.getKeyringForDevice(deviceName, hdPath)

    keyring.setAccountToUnlock(index)
    const oldAccounts = await this.keyringController.getAccounts()
    const keyState = await this.keyringController.addNewAccount(keyring)
    const newAccounts = await this.keyringController.getAccounts()
    this.preferencesController.setAddresses(newAccounts)
    newAccounts.forEach(address => {
      if (!oldAccounts.includes(address)) {
        // Set the account label to Trezor 1 /  Ledger 1, etc
        this.preferencesController.setAccountLabel(
          address,
          `${deviceName[0].toUpperCase()}${deviceName.slice(1)} ${parseInt(
            index,
            10
          ) + 1}`
        )
        // Select the account
        this.preferencesController.setSelectedAddress(address)
      }
    })

    const { identities } = this.preferencesController.store.getState()
    return { ...keyState, identities }
  }

  //
  // Account Management
  //

  /**
   * Adds a new account to the default (first) HD seed phrase Keyring.
   *
   * @returns {} keyState
   */
  async addNewAccount() {
    const primaryKeyring = this.keyringController.getKeyringsByType(
      'HD Key Tree'
    )[0]
    if (!primaryKeyring) {
      throw new Error('MetamaskController - No HD Key Tree found')
    }
    const keyringController = this.keyringController
    const oldAccounts = await keyringController.getAccounts()
    const keyState = await keyringController.addNewAccount(primaryKeyring)
    const newAccounts = await keyringController.getAccounts()

    await this.verifySeedPhrase()

    this.preferencesController.setAddresses(newAccounts)
    newAccounts.forEach(address => {
      if (!oldAccounts.includes(address)) {
        this.preferencesController.setSelectedAddress(address)
      }
    })

    const { identities } = this.preferencesController.store.getState()
    return { ...keyState, identities }
  }

  /**
   * Verifies the validity of the current vault's seed phrase.
   *
   * Validity: seed phrase restores the accounts belonging to the current vault.
   *
   * Called when the first account is created and on unlocking the vault.
   *
   * @returns {Promise<string>} - Seed phrase to be confirmed by the user.
   */
  async verifySeedPhrase() {
    const primaryKeyring = this.keyringController.getKeyringsByType(
      'HD Key Tree'
    )[0]
    if (!primaryKeyring) {
      throw new Error('MetamaskController - No HD Key Tree found')
    }

    const serialized = await primaryKeyring.serialize()
    const seedWords = serialized.mnemonic

    const accounts = await primaryKeyring.getAccounts()
    if (accounts.length < 1) {
      throw new Error('MetamaskController - No accounts found')
    }

    try {
      await seedPhraseVerifier.verifyAccounts(accounts, seedWords)
      return seedWords
    } catch (err) {
      log.error(err.message)
      throw err
    }
  }

  /**
   * Clears the transaction history, to allow users to force-reset their nonces.
   * Mostly used in development environments, when networks are restarted with
   * the same network ID.
   *
   * @returns {Promise<string>} - The current selected address.
   */
  async resetAccount() {
    const selectedAddress = this.preferencesController.getSelectedAddress()
    this.txController.wipeTransactions(selectedAddress)
    this.networkController.resetConnection()

    return selectedAddress
  }

  /**
   * Removes an account from state / storage.
   *
   * @param {string[]} address - A hex address
   *
   */
  async removeAccount(address) {
    // Remove account from the preferences controller
    this.preferencesController.removeAddress(address)
    // Remove account from the account tracker controller
    this.accountTracker.removeAccount([address])

    const domains = this.permissionsController.getAuthedSites([address])
    this.permissionsController.removePermissionsFor(domains)
    this.preferencesController.removeLastSelectedAddressesFor(
      Object.keys(domains)
    )

    // Remove account from the keyring
    await this.keyringController.removeAccount(address)
    return address
  }

  /**
   * Imports an account with the specified import strategy.
   * These are defined in app/scripts/account-import-strategies
   * Each strategy represents a different way of serializing an Ethereum key pair.
   *
   * @param  {string} strategy - A unique identifier for an account import strategy.
   * @param  {any} args - The data required by that strategy to import an account.
   * @param  {Function} cb - A callback function called with a state update on success.
   */
  async importAccountWithStrategy(strategy, args) {
    const privateKey = await accountImporter.importAccount(strategy, args)
    const keyring = await this.keyringController.addNewKeyring(
      'Simple Key Pair',
      [privateKey]
    )
    const accounts = await keyring.getAccounts()
    // update accounts in preferences controller
    const allAccounts = await this.keyringController.getAccounts()
    this.preferencesController.setAddresses(allAccounts)
    // set new account as selected
    await this.preferencesController.setSelectedAddress(accounts[0])
  }

  /**
   * Handle when a new account is selected for the given origin in the UI.
   * Stores the address by origin and notifies external providers associated
   * with the origin.
   * @param {string} origin - The origin for which the address was selected.
   * @param {string} address - The new selected address.
   */
  async handleNewAccountSelected(origin, address) {
    this.permissionsController.handleNewAccountSelected(origin, address)
    this.preferencesController.setLastSelectedAddress(origin, address)
  }

  // ---------------------------------------------------------------------------
  // Identity Management (signature operations)

  /**
   * Called when a Dapp suggests a new tx to be signed.
   * this wrapper needs to exist so we can provide a reference to
   *  "newUnapprovedTransaction" before "txController" is instantiated
   *
   * @param {Object} msgParams - The params passed to eth_sign.
   * @param {Object} req - (optional) the original request, containing the origin
   */
  async newUnapprovedTransaction(txParams, req) {
    return await this.txController.newUnapprovedTransaction(txParams, req)
  }

  // eth_sign methods:

  /**
   * Called when a Dapp uses the eth_sign method, to request user approval.
   * eth_sign is a pure signature of arbitrary data. It is on a deprecation
   * path, since this data can be a transaction, or can leak private key
   * information.
   *
   * @param {Object} msgParams - The params passed to eth_sign.
   * @param {Function} cb = The callback function called with the signature.
   */
  newUnsignedMessage(msgParams, req) {
    const promise = this.messageManager.addUnapprovedMessageAsync(
      msgParams,
      req
    )
    this.sendUpdate()
    this.opts.showUnconfirmedMessage()
    return promise
  }

  /**
   * Signifies user intent to complete an eth_sign method.
   *
   * @param  {Object} msgParams - The params passed to eth_call.
   * @returns {Promise<Object>} - Full state update.
   */
  signMessage(msgParams) {
    log.info('MetaMaskController - signMessage')
    const msgId = msgParams.metamaskId

    // sets the status op the message to 'approved'
    // and removes the metamaskId for signing
    return this.messageManager
      .approveMessage(msgParams)
      .then(cleanMsgParams => {
        // signs the message
        return this.keyringController.signMessage(cleanMsgParams)
      })
      .then(rawSig => {
        // tells the listener that the message has been signed
        // and can be returned to the dapp
        this.messageManager.setMsgStatusSigned(msgId, rawSig)
        return this.getState()
      })
  }

  /**
   * Used to cancel a message submitted via eth_sign.
   *
   * @param {string} msgId - The id of the message to cancel.
   */
  cancelMessage(msgId, cb) {
    const messageManager = this.messageManager
    messageManager.rejectMsg(msgId)
    if (cb && typeof cb === 'function') {
      cb(null, this.getState())
    }
  }

  // personal_sign methods:

  /**
   * Called when a dapp uses the personal_sign method.
   * This is identical to the Geth eth_sign method, and may eventually replace
   * eth_sign.
   *
   * We currently define our eth_sign and personal_sign mostly for legacy Dapps.
   *
   * @param {Object} msgParams - The params of the message to sign & return to the Dapp.
   * @param {Function} cb - The callback function called with the signature.
   * Passed back to the requesting Dapp.
   */
  async newUnsignedPersonalMessage(msgParams, req) {
    const promise = this.personalMessageManager.addUnapprovedMessageAsync(
      msgParams,
      req
    )
    this.sendUpdate()
    this.opts.showUnconfirmedMessage()
    return promise
  }

  /**
   * Signifies a user's approval to sign a personal_sign message in queue.
   * Triggers signing, and the callback function from newUnsignedPersonalMessage.
   *
   * @param {Object} msgParams - The params of the message to sign & return to the Dapp.
   * @returns {Promise<Object>} - A full state update.
   */
  signPersonalMessage(msgParams) {
    log.info('MetaMaskController - signPersonalMessage')
    const msgId = msgParams.metamaskId
    // sets the status op the message to 'approved'
    // and removes the metamaskId for signing
    return this.personalMessageManager
      .approveMessage(msgParams)
      .then(cleanMsgParams => {
        // signs the message
        return this.keyringController.signPersonalMessage(cleanMsgParams)
      })
      .then(rawSig => {
        // tells the listener that the message has been signed
        // and can be returned to the dapp
        this.personalMessageManager.setMsgStatusSigned(msgId, rawSig)
        return this.getState()
      })
  }

  /**
   * Used to cancel a personal_sign type message.
   * @param {string} msgId - The ID of the message to cancel.
   * @param {Function} cb - The callback function called with a full state update.
   */
  cancelPersonalMessage(msgId, cb) {
    const messageManager = this.personalMessageManager
    messageManager.rejectMsg(msgId)
    if (cb && typeof cb === 'function') {
      cb(null, this.getState())
    }
  }

  // eth_decrypt methods

  /**
   * Called when a dapp uses the eth_decrypt method.
   *
   * @param {Object} msgParams - The params of the message to sign & return to the Dapp.
   * @param {Object} req - (optional) the original request, containing the origin
   * Passed back to the requesting Dapp.
   */
  async newRequestDecryptMessage(msgParams, req) {
    const promise = this.decryptMessageManager.addUnapprovedMessageAsync(
      msgParams,
      req
    )
    this.sendUpdate()
    this.opts.showUnconfirmedMessage()
    return promise
  }

  /**
   * Only decypt message and don't touch transaction state
   *
   * @param {Object} msgParams - The params of the message to decrypt.
   * @returns {Promise<Object>} - A full state update.
   */
  async decryptMessageInline(msgParams) {
    log.info('MetaMaskController - decryptMessageInline')
    // decrypt the message inline
    const msgId = msgParams.metamaskId
    const msg = this.decryptMessageManager.getMsg(msgId)
    try {
      const stripped = stripHexPrefix(msgParams.data)
      const buff = Buffer.from(stripped, 'hex')
      msgParams.data = JSON.parse(buff.toString('utf8'))

      msg.rawData = await this.keyringController.decryptMessage(msgParams)
    } catch (e) {
      msg.error = e.message
    }
    this.decryptMessageManager._updateMsg(msg)

    return this.getState()
  }

  /**
   * Signifies a user's approval to decrypt a message in queue.
   * Triggers decrypt, and the callback function from newUnsignedDecryptMessage.
   *
   * @param {Object} msgParams - The params of the message to decrypt & return to the Dapp.
   * @returns {Promise<Object>} - A full state update.
   */
  async decryptMessage(msgParams) {
    log.info('MetaMaskController - decryptMessage')
    const msgId = msgParams.metamaskId
    // sets the status op the message to 'approved'
    // and removes the metamaskId for decryption
    try {
      const cleanMsgParams = await this.decryptMessageManager.approveMessage(
        msgParams
      )

      const stripped = stripHexPrefix(cleanMsgParams.data)
      const buff = Buffer.from(stripped, 'hex')
      cleanMsgParams.data = JSON.parse(buff.toString('utf8'))

      // decrypt the message
      const rawMess = await this.keyringController.decryptMessage(
        cleanMsgParams
      )
      // tells the listener that the message has been decrypted and can be returned to the dapp
      this.decryptMessageManager.setMsgStatusDecrypted(msgId, rawMess)
    } catch (error) {
      log.info('MetaMaskController - eth_decrypt failed.', error)
      this.decryptMessageManager.errorMessage(msgId, error)
    }
    return this.getState()
  }

  /**
   * Used to cancel a eth_decrypt type message.
   * @param {string} msgId - The ID of the message to cancel.
   * @param {Function} cb - The callback function called with a full state update.
   */
  cancelDecryptMessage(msgId, cb) {
    const messageManager = this.decryptMessageManager
    messageManager.rejectMsg(msgId)
    if (cb && typeof cb === 'function') {
      cb(null, this.getState())
    }
  }

  // eth_getEncryptionPublicKey methods

  /**
   * Called when a dapp uses the eth_getEncryptionPublicKey method.
   *
   * @param {Object} msgParams - The params of the message to sign & return to the Dapp.
   * @param {Object} req - (optional) the original request, containing the origin
   * Passed back to the requesting Dapp.
   */
  async newRequestEncryptionPublicKey(msgParams, req) {
    const promise = this.encryptionPublicKeyManager.addUnapprovedMessageAsync(
      msgParams,
      req
    )
    this.sendUpdate()
    this.opts.showUnconfirmedMessage()
    return promise
  }

  /**
   * Signifies a user's approval to receiving encryption public key in queue.
   * Triggers receiving, and the callback function from newUnsignedEncryptionPublicKey.
   *
   * @param {Object} msgParams - The params of the message to receive & return to the Dapp.
   * @returns {Promise<Object>} - A full state update.
   */
  async encryptionPublicKey(msgParams) {
    log.info('MetaMaskController - encryptionPublicKey')
    const msgId = msgParams.metamaskId
    // sets the status op the message to 'approved'
    // and removes the metamaskId for decryption
    try {
      const params = await this.encryptionPublicKeyManager.approveMessage(
        msgParams
      )

      // EncryptionPublicKey message
      const publicKey = await this.keyringController.getEncryptionPublicKey(
        params.data
      )

      // tells the listener that the message has been processed
      // and can be returned to the dapp
      this.encryptionPublicKeyManager.setMsgStatusReceived(msgId, publicKey)
    } catch (error) {
      log.info('MetaMaskController - eth_getEncryptionPublicKey failed.', error)
      this.encryptionPublicKeyManager.errorMessage(msgId, error)
    }
    return this.getState()
  }

  /**
   * Used to cancel a eth_getEncryptionPublicKey type message.
   * @param {string} msgId - The ID of the message to cancel.
   * @param {Function} cb - The callback function called with a full state update.
   */
  cancelEncryptionPublicKey(msgId, cb) {
    const messageManager = this.encryptionPublicKeyManager
    messageManager.rejectMsg(msgId)
    if (cb && typeof cb === 'function') {
      cb(null, this.getState())
    }
  }

  // eth_signTypedData methods

  /**
   * Called when a dapp uses the eth_signTypedData method, per EIP 712.
   *
   * @param {Object} msgParams - The params passed to eth_signTypedData.
   * @param {Function} cb - The callback function, called with the signature.
   */
  newUnsignedTypedMessage(msgParams, req, version) {
    const promise = this.typedMessageManager.addUnapprovedMessageAsync(
      msgParams,
      req,
      version
    )
    this.sendUpdate()
    this.opts.showUnconfirmedMessage()
    return promise
  }

  /**
   * The method for a user approving a call to eth_signTypedData, per EIP 712.
   * Triggers the callback in newUnsignedTypedMessage.
   *
   * @param  {Object} msgParams - The params passed to eth_signTypedData.
   * @returns {Object} - Full state update.
   */
  async signTypedMessage(msgParams) {
    log.info('MetaMaskController - eth_signTypedData')
    const msgId = msgParams.metamaskId
    const version = msgParams.version
    try {
      const cleanMsgParams = await this.typedMessageManager.approveMessage(
        msgParams
      )

      // For some reason every version after V1 used stringified params.
      if (version !== 'V1') {
        // But we don't have to require that. We can stop suggesting it now:
        if (typeof cleanMsgParams.data === 'string') {
          cleanMsgParams.data = JSON.parse(cleanMsgParams.data)
        }
      }

      const signature = await this.keyringController.signTypedMessage(
        cleanMsgParams,
        { version }
      )
      this.typedMessageManager.setMsgStatusSigned(msgId, signature)
      return this.getState()
    } catch (error) {
      log.info('MetaMaskController - eth_signTypedData failed.', error)
      this.typedMessageManager.errorMessage(msgId, error)
    }
  }

  /**
   * Used to cancel a eth_signTypedData type message.
   * @param {string} msgId - The ID of the message to cancel.
   * @param {Function} cb - The callback function called with a full state update.
   */
  cancelTypedMessage(msgId, cb) {
    const messageManager = this.typedMessageManager
    messageManager.rejectMsg(msgId)
    if (cb && typeof cb === 'function') {
      cb(null, this.getState())
    }
  }

  //=============================================================================
  // END (VAULT / KEYRING RELATED METHODS)
  //=============================================================================

  /**
   * Allows a user to try to speed up a transaction by retrying it
   * with higher gas.
   *
   * @param {string} txId - The ID of the transaction to speed up.
   */
  async retryTransaction(txId, gasPrice) {
    await this.txController.retryTransaction(txId, gasPrice)
    const state = await this.getState()
    return state
  }

  /**
   * Allows a user to attempt to cancel a previously submitted transaction by creating a new
   * transaction.
   * @param {number} originalTxId - the id of the txMeta that you want to attempt to cancel
   * @param {string} [customGasPrice] - the hex value to use for the cancel transaction
   * @returns {Object} - MetaMask state
   */
  async createCancelTransaction(originalTxId, customGasPrice) {
    try {
      await this.txController.createCancelTransaction(
        originalTxId,
        customGasPrice
      )
      const state = await this.getState()
      return state
    } catch (error) {
      throw error
    }
  }

  async createSpeedUpTransaction(originalTxId, customGasPrice) {
    await this.txController.createSpeedUpTransaction(
      originalTxId,
      customGasPrice
    )
    const state = await this.getState()
    return state
  }

  async estimateGas(estimateGasParams) {
    return new Promise((resolve, reject) => {
      this.txController.txGasUtil.query.estimateGas(
        { ...estimateGasParams },
        (err, res) => {
          if (err) {
            reject(err)
          }
          resolve(res)
        }
      )
    })
  }

  async checkBalanceAgainstTransaction(checkBalanceAgainstTransactionParams) {
    return new Promise((resolve, reject) => {
      this.txController.query.checkBalanceAgainstTransaction(
        ...checkBalanceAgainstTransactionParams,
        (err, res) => {
          if (err) {
            reject(err)
          }
          resolve(res)
        }
      )
    })
  }

  //=============================================================================
  // PASSWORD MANAGEMENT
  //=============================================================================

  /**
   * Allows a user to begin the seed phrase recovery process.
   * @param {Function} cb - A callback function called when complete.
   */
  markPasswordForgotten(cb) {
    this.preferencesController.setPasswordForgotten(true)
    this.sendUpdate()
    cb()
  }

  /**
   * Allows a user to end the seed phrase recovery process.
   * @param {Function} cb - A callback function called when complete.
   */
  unMarkPasswordForgotten(cb) {
    this.preferencesController.setPasswordForgotten(false)
    this.sendUpdate()
    cb()
  }

  //=============================================================================
  // SETUP
  //=============================================================================

  /**
   * A runtime.MessageSender object, as provided by the browser:
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/MessageSender
   * @typedef {Object} MessageSender
   */

  /**
   * Used to create a multiplexed stream for connecting to an untrusted context
   * like a Dapp or other extension.
   * @param {*} connectionStream - The Duplex stream to connect to.
   * @param {MessageSender} sender - The sender of the messages on this stream
   */
  setupUntrustedCommunication(connectionStream, sender) {
    const hostname = new URL(sender.url).hostname
    // Check if new connection is blacklisted
    if (this.phishingController.test(hostname)) {
      log.debug('MetaMask - sending phishing warning for', hostname)
      this.sendPhishingWarning(connectionStream, hostname)
      return
    }

    // setup multiplexing
    const mux = setupMultiplex(connectionStream)

    // messages between inpage and background
    this.setupProviderConnection(
      mux.createStream('confluxPortalProvider'),
      sender
    )
    this.setupPublicConfig(mux.createStream('confluxPortalPublicConfig'))
  }

  /**
   * Used to create a multiplexed stream for connecting to a trusted context,
   * like our own user interfaces, which have the provider APIs, but also
   * receive the exported API from this controller, which includes trusted
   * functions, like the ability to approve transactions or sign messages.
   *
   * @param {*} connectionStream - The duplex stream to connect to.
   * @param {MessageSender} sender - The sender of the messages on this stream
   */
  setupTrustedCommunication(connectionStream, sender) {
    // setup multiplexing
    const mux = setupMultiplex(connectionStream)
    // connect features
    this.setupControllerConnection(mux.createStream('confluxPortalController'))
    this.preferencesController.setPreference(
      'useNativeCurrencyAsPrimaryCurrency',
      true
    )
    this.setupProviderConnection(
      mux.createStream('confluxPortalProvider'),
      sender,
      true
    )
  }

  /**
   * Called when we detect a suspicious domain. Requests the browser redirects
   * to our anti-phishing page.
   *
   * @private
   * @param {*} connectionStream - The duplex stream to the per-page script,
   * for sending the reload attempt to.
   * @param {string} hostname - The URL that triggered the suspicion.
   */
  sendPhishingWarning(connectionStream, hostname) {
    const mux = setupMultiplex(connectionStream)
    const phishingStream = mux.createStream('confluxPortalPhishing')
    phishingStream.write({ hostname })
  }

  /**
   * A method for providing our API over a stream using Dnode.
   * @param {*} outStream - The stream to provide our API over.
   */
  setupControllerConnection(outStream) {
    const api = this.getApi()

    const dnode = Dnode(api)
    // report new active controller connection
    this.activeControllerConnections++
    this.emit('controllerConnectionChanged', this.activeControllerConnections)
    // connect dnode api to remote connection
    pump(outStream, dnode, outStream, err => {
      // report new active controller connection
      this.activeControllerConnections--
      this.emit('controllerConnectionChanged', this.activeControllerConnections)
      // report any error
      if (err) {
        log.error(err)
      }
    })
    dnode.on('remote', remote => {
      // push updates to popup
      const sendUpdate = update => remote.sendUpdate(update)
      this.on('update', sendUpdate)
      // remove update listener once the connection ends
      dnode.on('end', () => this.removeListener('update', sendUpdate))
    })
  }

  /**
   * A method for serving our ethereum provider over a given stream.
   * @param {*} outStream - The stream to provide over.
   * @param {MessageSender} sender - The sender of the messages on this stream
   * @param {boolean} isInternal - True if this is a connection with an internal process
   */
  setupProviderConnection(outStream, sender, isInternal) {
    const origin = isInternal ? 'metamask' : new URL(sender.url).hostname
    let extensionId
    if (sender.id !== extension.runtime.id) {
      extensionId = sender.id
    }
    let tabId
    if (sender.tab && sender.tab.id) {
      tabId = sender.tab.id
    }

    const engine = this.setupProviderEngine({
      origin,
      location: sender.url,
      extensionId,
      tabId,
    })

    // setup connection
    const providerStream = createEngineStream({ engine })

    const connectionId = this.addConnection(origin, { engine })

    pump(outStream, providerStream, outStream, err => {
      // handle any middleware cleanup
      engine._middleware.forEach(mid => {
        if (mid.destroy && typeof mid.destroy === 'function') {
          mid.destroy()
        }
      })
      connectionId && this.removeConnection(origin, connectionId)
      if (err) {
        log.error(err)
      }
    })
  }

  /**
   * A method for creating a provider that is safely restricted for the requesting domain.
   * @param {Object} options - Provider engine options
   * @param {string} options.origin - The hostname of the sender
   * @param {string} options.location - The full URL of the sender
   * @param {extensionId} [options.extensionId] - The extension ID of the sender, if the sender is an external extension
   * @param {tabId} [options.tabId] - The tab ID of the sender - if the sender is within a tab
   **/
  setupProviderEngine({ origin, location, extensionId, tabId }) {
    // setup json rpc engine stack
    const engine = new RpcEngine()
    const provider = this.provider
    const blockTracker = this.blockTracker

    // create filter polyfill middleware
    const filterMiddleware = createFilterMiddleware({ provider, blockTracker })

    // create subscription polyfill middleware
    const subscriptionManager = createSubscriptionManager({
      provider,
      blockTracker,
    })
    subscriptionManager.events.on('notification', message =>
      engine.emit('notification', message)
    )

    // append origin to each request
    engine.push(createOriginMiddleware({ origin }))
    // logging
    engine.push(createLoggerMiddleware({ origin }))
    engine.push(
      createOnboardingMiddleware({
        location,
        tabId,
        registerOnboarding: this.onboardingController.registerOnboarding,
      })
    )
    // filter and subscription polyfills
    engine.push(filterMiddleware)
    engine.push(subscriptionManager.middleware)
    // permissions
    engine.push(
      this.permissionsController.createMiddleware({ origin, extensionId })
    )
    // watch asset
    engine.push(
      this.preferencesController.requestWatchAsset.bind(
        this.preferencesController
      )
    )
    // forward to metamask primary provider
    engine.push(providerAsMiddleware(provider))
    return engine
  }

  /**
   * A method for providing our public config info over a stream.
   * This includes info we like to be synchronous if possible, like
   * the current selected account, and network ID.
   *
   * Since synchronous methods have been deprecated in web3,
   * this is a good candidate for deprecation.
   *
   * @param {*} outStream - The stream to provide public config over.
   */
  setupPublicConfig(outStream) {
    const configStore = this.createPublicConfigStore()
    const configStream = asStream(configStore)

    pump(configStream, outStream, err => {
      configStore.destroy()
      configStream.destroy()
      if (err) {
        log.error(err)
      }
    })
  }

  /**
   * Adds a reference to a connection by origin. Ignores the 'metamask' origin.
   * Caller must ensure that the returned id is stored such that the reference
   * can be deleted later.
   *
   * @param {string} origin - The connection's origin string.
   * @param {Object} options - Data associated with the connection
   * @param {Object} options.engine - The connection's JSON Rpc Engine
   * @returns {string} - The connection's id (so that it can be deleted later)
   */
  addConnection(origin, { engine }) {
    if (origin === 'metamask') {
      return null
    }

    if (!this.connections[origin]) {
      this.connections[origin] = {}
    }

    const id = nanoid()
    this.connections[origin][id] = {
      engine,
    }

    return id
  }

  /**
   * Deletes a reference to a connection, by origin and id.
   * Ignores unknown origins.
   *
   * @param {string} origin - The connection's origin string.
   * @param {string} id - The connection's id, as returned from addConnection.
   */
  removeConnection(origin, id) {
    const connections = this.connections[origin]
    if (!connections) {
      return
    }

    delete connections[id]

    if (Object.keys(connections.length === 0)) {
      delete this.connections[origin]
    }
  }

  /**
   * Causes the RPC engines associated with the connections to the given origin
   * to emit a notification event with the given payload.
   * Does nothing if the extension is locked or the origin is unknown.
   *
   * @param {string} origin - The connection's origin string.
   * @param {any} payload - The event payload.
   */
  notifyConnections(origin, payload) {
    const { isUnlocked } = this.getState()
    const connections = this.connections[origin]
    if (!isUnlocked || !connections) {
      return
    }

    Object.values(connections).forEach(conn => {
      conn.engine && conn.engine.emit('notification', payload)
    })
  }

  /**
   * Causes the RPC engines associated with all connections to emit a
   * notification event with the given payload.
   * Does nothing if the extension is locked.
   *
   * @param {any} payload - The event payload.
   */
  notifyAllConnections(payload) {
    const { isUnlocked } = this.getState()
    if (!isUnlocked) {
      return
    }

    Object.values(this.connections).forEach(origin => {
      Object.values(origin).forEach(conn => {
        conn.engine && conn.engine.emit('notification', payload)
      })
    })
  }

  // handlers

  /**
   * Handle a KeyringController update
   * @param {Object} state - the KC state
   * @returns {Promise<void>}
   * @private
   */
  async _onKeyringControllerUpdate(state) {
    const { isUnlocked, keyrings } = state
    const addresses = keyrings.reduce(
      (acc, { accounts }) => acc.concat(accounts),
      []
    )

    if (!addresses.length) {
      return
    }

    // Ensure preferences + identities controller know about all addresses
    this.preferencesController.addAddresses(addresses)
    this.accountTracker.syncWithAddresses(addresses)

    const wasLocked = !isUnlocked
    if (wasLocked) {
      const oldSelectedAddress = this.preferencesController.getSelectedAddress()
      if (!addresses.includes(oldSelectedAddress)) {
        const address = addresses[0]
        await this.preferencesController.setSelectedAddress(address)
      }
    }
  }

  // misc

  /**
   * A method for emitting the full MetaMask state to all registered listeners.
   * @private
   */
  privateSendUpdate() {
    this.emit('update', this.getState())
  }

  //=============================================================================
  // MISCELLANEOUS
  //=============================================================================

  /**
   * call gasPrice rpc method
   *
   * @returns {string} - A hex representation of the suggested wei gas price.
   */
  getGasPrice() {
    return this.txController.query.gasPrice()
  }

  /**
   * Returns the nonce that will be associated with a transaction once approved
   * @param {string} address - The hex string address for the transaction
   * @returns {Promise<number>}
   */
  async getPendingNonce(address) {
    const {
      nonceDetails,
      releaseLock,
    } = await this.txController.nonceTracker.getNonceLock(address)
    const pendingNonce = nonceDetails.params.highestSuggested

    releaseLock()
    return pendingNonce
  }

  /**
   * Returns the next nonce according to the nonce-tracker
   * @param {string} address - The hex string address for the transaction
   * @returns {Promise<number>}
   */
  async getNextNonce(address) {
    let nonceLock
    try {
      nonceLock = await this.txController.nonceTracker.getNonceLock(address)
    } finally {
      nonceLock.releaseLock()
    }
    return nonceLock.nextNonce
  }

  //=============================================================================
  // CONFIG
  //=============================================================================

  // Log blocks

  /**
   * A method for setting the user's preferred display currency.
   * @param {string} currencyCode - The code of the preferred currency.
   * @param {Function} cb - A callback function returning currency info.
   */
  setCurrentCurrency(currencyCode, cb) {
    // const { ticker } = this.networkController.getNetworkConfig()
    try {
      const currencyState = {
        nativeCurrency: 'CFX',
        currentCurrency: currencyCode,
      }
      this.currencyRateController.update(currencyState)
      this.currencyRateController.configure(currencyState)
      cb(null, this.currencyRateController.state)
    } catch (err) {
      cb(err)
    }
  }

  /**
   * A method for forwarding the user to the easiest way to obtain ether,
   * or the network "gas" currency, for the current selected network.
   *
   * @param {string} address - The address to fund.
   * @param {string} amount - The amount of ether desired, as a base 10 string.
   */
  buyEth(address, amount) {
    if (!amount) {
      amount = '5'
    }
    const network = this.networkController.getNetworkState()
    const { type } = this.networkController.getProviderConfig()
    const url = getBuyEthUrl({ network, address, amount, type })
    if (url) {
      this.platform.openWindow({ url })
    }
  }

  // network
  /**
   * A method for selecting a custom URL for an ethereum RPC provider and updating it
   * @param {string} rpcUrl - A URL for a valid Ethereum RPC API.
   * @param {number} chainId - The decimal chainId of the selected network or
   empty string.
   * @param {string} ticker - The ticker symbol of the selected network.
   * @param {string} nickname - Optional nickname of the selected network.
   * @returns {Promise<String>} - The RPC Target URL confirmed.
   */

  async updateAndSetCustomRpc(
    rpcUrl,
    chainId,
    ticker = 'CFX',
    nickname,
    rpcPrefs
  ) {
    const networkStatus = await getStatus(rpcUrl)
    chainId = parseInt(networkStatus.chainId, 16).toString(10)
    await this.preferencesController.updateRpc({
      rpcUrl,
      chainId,
      ticker,
      nickname,
      rpcPrefs,
    })
    this.networkController.setRpcTarget(
      rpcUrl,
      chainId,
      ticker,
      nickname,
      rpcPrefs
    )
    return rpcUrl
  }

  /**
   * A method for selecting a custom URL for an ethereum RPC provider.
   * @param {string} rpcTarget - A URL for a valid Ethereum RPC API.
   * @param {number} chainId - The chainId of the selected network.
   * @param {string} ticker - The ticker symbol of the selected network.
   * @param {string} nickname - Optional nickname of the selected network.
   * @returns {Promise<String>} - The RPC Target URL confirmed.
   */
  async setCustomRpc(
    rpcTarget,
    chainId,
    ticker = 'CFX',
    nickname = '',
    rpcPrefs = {}
  ) {
    const frequentRpcListDetail = this.preferencesController.getFrequentRpcListDetail()
    const rpcSettings = frequentRpcListDetail.find(
      rpc => rpcTarget === rpc.rpcUrl
    )

    if (rpcSettings) {
      this.networkController.setRpcTarget(
        rpcSettings.rpcUrl,
        rpcSettings.chainId,
        rpcSettings.ticker,
        rpcSettings.nickname,
        rpcPrefs
      )
    } else {
      this.networkController.setRpcTarget(
        rpcTarget,
        chainId,
        ticker,
        nickname,
        rpcPrefs
      )
      await this.preferencesController.addToFrequentRpcList(
        rpcTarget,
        chainId,
        ticker,
        nickname,
        rpcPrefs
      )
    }
    return rpcTarget
  }

  /**
   * A method for deleting a selected custom URL.
   * @param {string} rpcTarget - A RPC URL to delete.
   */
  async delCustomRpc(rpcTarget) {
    await this.preferencesController.removeFromFrequentRpcList(rpcTarget)
  }

  // async initializeThreeBox () {
  //   await this.threeBoxController.init()
  // }

  /**
   * Sets whether or not to use the blockie identicon format.
   * @param {boolean} val - True for bockie, false for jazzicon.
   * @param {Function} cb - A callback function called when complete.
   */
  setUseBlockie(val, cb) {
    try {
      this.preferencesController.setUseBlockie(val)
      cb(null)
    } catch (err) {
      cb(err)
    }
  }

  /**
   * Sets whether or not to use the nonce field.
   * @param {boolean} val - True for nonce field, false for not nonce field.
   * @param {Function} cb - A callback function called when complete.
   */
  setUseNonceField(val, cb) {
    try {
      this.preferencesController.setUseNonceField(val)
      cb(null)
    } catch (err) {
      cb(err)
    }
  }

  /**
   * Sets the IPFS gateway to use for ENS content resolution.
   * @param {string} val - the host of the gateway to set
   * @param {Function} cb - A callback function called when complete.
   */
  setIpfsGateway(val, cb) {
    try {
      this.preferencesController.setIpfsGateway(val)
      cb(null)
    } catch (err) {
      cb(err)
    }
  }

  /**
   * Sets whether or not the user will have usage data tracked with MetaMetrics
   * @param {boolean} bool - True for users that wish to opt-in, false for users that wish to remain out.
   * @param {Function} cb - A callback function called when complete.
   */
  setParticipateInMetaMetrics(bool, cb) {
    try {
      const metaMetricsId = this.preferencesController.setParticipateInMetaMetrics(
        bool
      )
      cb(null, metaMetricsId)
    } catch (err) {
      cb(err)
    }
  }

  setMetaMetricsSendCount(val, cb) {
    try {
      this.preferencesController.setMetaMetricsSendCount(val)
      cb(null)
    } catch (err) {
      cb(err)
    }
  }

  /**
   * Sets the type of first time flow the user wishes to follow: create or import
   * @param {string} type - Indicates the type of first time flow the user wishes to follow
   * @param {Function} cb - A callback function called when complete.
   */
  setFirstTimeFlowType(type, cb) {
    try {
      this.preferencesController.setFirstTimeFlowType(type)
      cb(null)
    } catch (err) {
      cb(err)
    }
  }

  /**
   * A method for setting a user's current locale, affecting the language rendered.
   * @param {string} key - Locale identifier.
   * @param {Function} cb - A callback function called when complete.
   */
  setCurrentLocale(key, cb) {
    try {
      const direction = this.preferencesController.setCurrentLocale(key)
      cb(null, direction)
    } catch (err) {
      cb(err)
    }
  }

  /**
   * A method for initializing storage the first time.
   * @param {Object} initState - The default state to initialize with.
   * @private
   */
  recordFirstTimeInfo(initState) {
    if (!('firstTimeInfo' in initState)) {
      initState.firstTimeInfo = {
        version,
        date: Date.now(),
      }
    }
  }

  // TODO: Replace isClientOpen methods with `controllerConnectionChanged` events.
  /**
   * A method for recording whether the MetaMask user interface is open or not.
   * @private
   * @param {boolean} open
   */
  set isClientOpen(open) {
    this._isClientOpen = open
    this.isClientOpenAndUnlocked = this.getState().isUnlocked && open
    this.detectTokensController.isOpen = open
  }

  /**
   * A method for activating the retrieval of price data,
   * which should only be fetched when the UI is visible.
   * @private
   * @param {boolean} active - True if price data should be getting fetched.
   */
  set isClientOpenAndUnlocked(active) {
    // this.tokenRatesController.isActive = active
  }

  /**
   * Creates RPC engine middleware for processing eth_signTypedData requests
   *
   * @param {Object} req - request object
   * @param {Object} res - response object
   * @param {Function} - next
   * @param {Function} - end
   */

  /**
   * Adds a domain to the PhishingController whitelist
   * @param {string} hostname - the domain to whitelist
   */
  whitelistPhishingDomain(hostname) {
    return this.phishingController.bypass(hostname)
  }

  /**
   * Locks MetaMask
   */
  setLocked() {
    return this.keyringController.setLocked()
  }
}
