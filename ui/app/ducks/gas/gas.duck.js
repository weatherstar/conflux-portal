import { clone, uniqBy, flatten } from 'ramda'
import BigNumber from 'bignumber.js'
import {
  loadLocalStorageData,
  saveLocalStorageData,
} from '../../../lib/local-storage-helpers'
import { addCurrencies } from '../../helpers/utils/conversion-util'
import { isEthereumNetwork } from '../../selectors/selectors'
import {
  showLoadingIndication,
  hideLoadingIndication,
} from '../../store/actions'

// Actions
const BASIC_GAS_ESTIMATE_LOADING_FINISHED =
  'metamask/gas/BASIC_GAS_ESTIMATE_LOADING_FINISHED'
const BASIC_GAS_ESTIMATE_LOADING_STARTED =
  'metamask/gas/BASIC_GAS_ESTIMATE_LOADING_STARTED'
const GAS_ESTIMATE_LOADING_FINISHED =
  'metamask/gas/GAS_ESTIMATE_LOADING_FINISHED'
const GAS_ESTIMATE_LOADING_STARTED = 'metamask/gas/GAS_ESTIMATE_LOADING_STARTED'
const RESET_CUSTOM_GAS_STATE = 'metamask/gas/RESET_CUSTOM_GAS_STATE'
const RESET_CUSTOM_GAS_DATA = 'metamask/gas/RESET_CUSTOM_GAS_DATA'
const SET_BASIC_GAS_ESTIMATE_DATA = 'metamask/gas/SET_BASIC_GAS_ESTIMATE_DATA'
const SET_CUSTOM_GAS_ERRORS = 'metamask/gas/SET_CUSTOM_GAS_ERRORS'
const SET_CUSTOM_GAS_LIMIT = 'metamask/gas/SET_CUSTOM_GAS_LIMIT'
const SET_CUSTOM_GAS_PRICE = 'metamask/gas/SET_CUSTOM_GAS_PRICE'
const SET_CUSTOM_GAS_TOTAL = 'metamask/gas/SET_CUSTOM_GAS_TOTAL'
const SET_PRICE_AND_TIME_ESTIMATES = 'metamask/gas/SET_PRICE_AND_TIME_ESTIMATES'
const SET_API_ESTIMATES_LAST_RETRIEVED =
  'metamask/gas/SET_API_ESTIMATES_LAST_RETRIEVED'
const SET_BASIC_API_ESTIMATES_LAST_RETRIEVED =
  'metamask/gas/SET_BASIC_API_ESTIMATES_LAST_RETRIEVED'
const SET_BASIC_PRICE_ESTIMATES_LAST_RETRIEVED =
  'metamask/gas/SET_BASIC_PRICE_ESTIMATES_LAST_RETRIEVED'

// state.gas
const initState = {
  customData: {
    price: null,
    limit: null,
    total: null,
  },
  basicEstimates: {
    average: null,
    fastestWait: null,
    fastWait: null,
    fast: null,
    safeLowWait: null,
    blockNum: null,
    avgWait: null,
    blockTime: null,
    speed: null,
    fastest: null,
    safeLow: null,
  },
  basicEstimateIsLoading: true,
  gasEstimatesLoading: true,
  priceAndTimeEstimates: [],
  priceAndTimeEstimatesLastRetrieved: 0,
  basicPriceAndTimeEstimatesLastRetrieved: 0,
  basicPriceEstimatesLastRetrieved: 0,
  errors: {},
}

// Reducer
export default function reducer(state = initState, action) {
  switch (action.type) {
    case BASIC_GAS_ESTIMATE_LOADING_STARTED:
      return {
        ...state,
        basicEstimateIsLoading: true,
      }
    case BASIC_GAS_ESTIMATE_LOADING_FINISHED:
      return {
        ...state,
        basicEstimateIsLoading: false,
      }
    case GAS_ESTIMATE_LOADING_STARTED:
      return {
        ...state,
        gasEstimatesLoading: true,
      }
    case GAS_ESTIMATE_LOADING_FINISHED:
      return {
        ...state,
        gasEstimatesLoading: false,
      }
    case SET_BASIC_GAS_ESTIMATE_DATA:
      return {
        ...state,
        basicEstimates: action.value,
      }
    case SET_CUSTOM_GAS_PRICE:
      return {
        ...state,
        customData: {
          ...state.customData,
          price: action.value,
        },
      }
    case SET_CUSTOM_GAS_LIMIT:
      return {
        ...state,
        customData: {
          ...state.customData,
          limit: action.value,
        },
      }
    case SET_CUSTOM_GAS_TOTAL:
      return {
        ...state,
        customData: {
          ...state.customData,
          total: action.value,
        },
      }
    case SET_PRICE_AND_TIME_ESTIMATES:
      return {
        ...state,
        priceAndTimeEstimates: action.value,
      }
    case SET_CUSTOM_GAS_ERRORS:
      return {
        ...state,
        errors: {
          ...state.errors,
          ...action.value,
        },
      }
    case SET_API_ESTIMATES_LAST_RETRIEVED:
      return {
        ...state,
        priceAndTimeEstimatesLastRetrieved: action.value,
      }
    case SET_BASIC_API_ESTIMATES_LAST_RETRIEVED:
      return {
        ...state,
        basicPriceAndTimeEstimatesLastRetrieved: action.value,
      }
    case SET_BASIC_PRICE_ESTIMATES_LAST_RETRIEVED:
      return {
        ...state,
        basicPriceEstimatesLastRetrieved: action.value,
      }
    case RESET_CUSTOM_GAS_DATA:
      return {
        ...state,
        customData: clone(initState.customData),
      }
    case RESET_CUSTOM_GAS_STATE:
      return clone(initState)
    default:
      return state
  }
}

// Action Creators
export function basicGasEstimatesLoadingStarted() {
  return {
    type: BASIC_GAS_ESTIMATE_LOADING_STARTED,
  }
}

export function basicGasEstimatesLoadingFinished() {
  return {
    type: BASIC_GAS_ESTIMATE_LOADING_FINISHED,
  }
}

export function gasEstimatesLoadingStarted() {
  return {
    type: GAS_ESTIMATE_LOADING_STARTED,
  }
}

export function gasEstimatesLoadingFinished() {
  return {
    type: GAS_ESTIMATE_LOADING_FINISHED,
  }
}

export function fetchBasicGasEstimates() {
  return async (dispatch, getState) => {
    const { basicPriceEstimatesLastRetrieved } = getState().gas
    const isMainnet = getState().metamask.settings.network === 1029
    const timeLastRetrieved =
      basicPriceEstimatesLastRetrieved ||
      loadLocalStorageData('BASIC_PRICE_ESTIMATES_LAST_RETRIEVED') ||
      0

    dispatch(showLoadingIndication())
    dispatch(basicGasEstimatesLoadingStarted())

    let basicEstimates
    if (Date.now() - timeLastRetrieved > 75000) {
      basicEstimates = await fetchExternalBasicGasEstimates(dispatch, isMainnet)
    } else {
      const cachedBasicEstimates = loadLocalStorageData('BASIC_PRICE_ESTIMATES')
      basicEstimates =
        cachedBasicEstimates ||
        (await fetchExternalBasicGasEstimates(dispatch, isMainnet))
    }

    dispatch(setBasicGasEstimateData(basicEstimates))
    dispatch(basicGasEstimatesLoadingFinished())
    dispatch(hideLoadingIndication())

    return basicEstimates
  }
}

async function fetchExternalBasicGasEstimates(dispatch, isMainnet) {
  let estimateGasGdripTimes10 = new BigNumber('0x3b9aca00', 16)
    .times(10)
    .div(1e9)
    .toNumber()

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
      estimateGasGdripTimes10 = new BigNumber(res.result.fastest, 16)
        .times(10)
        .div(1e9)
        .toNumber()
    }
  } else {
    estimateGasGdripTimes10 =
      // new BigNumber(estimateGasDrip, 16)
      new BigNumber('0x1', 16)
        .times(10)
        .div(1e9)
        .toNumber()
  }

  // const {
  //   safeLow: safeLowTimes10,
  //   // average: averageTimes10,
  //   fast: fastTimes10,
  //   fastest: fastestTimes10,
  //   block_time: blockTime,
  //   blockNum,
  // } = await response.json()

  const {
    safeLow: safeLowTimes10,
    // average: averageTimes10,
    fast: fastTimes10,
    fastest: fastestTimes10,
    block_time: blockTime,
    blockNum,
  } = {
    safeLow: estimateGasGdripTimes10,
    fast: estimateGasGdripTimes10,
    fastest: estimateGasGdripTimes10,
    block_time: 0.5,
    blockNum: 1,
  }

  const [average, fast, fastest, safeLow] = [
    // averageTimes10,
    estimateGasGdripTimes10,
    fastTimes10,
    fastestTimes10,
    safeLowTimes10,
  ].map(price => new BigNumber(price).div(10).toNumber())

  const basicEstimates = {
    safeLow,
    average,
    fast,
    fastest,
    blockTime,
    blockNum,
  }

  const timeRetrieved = Date.now()
  saveLocalStorageData(basicEstimates, 'BASIC_PRICE_ESTIMATES')
  saveLocalStorageData(timeRetrieved, 'BASIC_PRICE_ESTIMATES_LAST_RETRIEVED')
  dispatch(setBasicPriceEstimatesLastRetrieved(timeRetrieved))

  return basicEstimates
}

export function fetchBasicGasAndTimeEstimates() {
  return async (dispatch, getState) => {
    const { basicPriceAndTimeEstimatesLastRetrieved } = getState().gas
    const isMainnet = getState().metamask.settings.network === 1029
    const timeLastRetrieved =
      basicPriceAndTimeEstimatesLastRetrieved ||
      loadLocalStorageData('BASIC_GAS_AND_TIME_API_ESTIMATES_LAST_RETRIEVED') ||
      0

    dispatch(showLoadingIndication())
    dispatch(basicGasEstimatesLoadingStarted())

    let basicEstimates
    if (Date.now() - timeLastRetrieved > 75000) {
      basicEstimates = await fetchExternalBasicGasAndTimeEstimates(
        dispatch,
        isMainnet
      )
    } else {
      const cachedBasicEstimates = loadLocalStorageData(
        'BASIC_GAS_AND_TIME_API_ESTIMATES'
      )
      basicEstimates =
        cachedBasicEstimates ||
        (await fetchExternalBasicGasAndTimeEstimates(dispatch, isMainnet))
    }

    dispatch(setBasicGasEstimateData(basicEstimates))
    dispatch(basicGasEstimatesLoadingFinished())
    dispatch(hideLoadingIndication())
    return basicEstimates
  }
}

async function fetchExternalBasicGasAndTimeEstimates(dispatch, isMainnet) {
  let estimateGasGdripTimes10 = new BigNumber('0x3b9aca00', 16)
    .times(10)
    .div(1e9)
    .toNumber()

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
      estimateGasGdripTimes10 = new BigNumber(res.result.fastest, 16)
        .times(10)
        .div(1e9)
        .toNumber()
    }
  } else {
    estimateGasGdripTimes10 = new BigNumber('0x1', 16)
      .times(10)
      .div(1e9)
      .toNumber()
  }

  const {
    // average: averageTimes10,
    avgWait,
    block_time: blockTime,
    blockNum,
    fast: fastTimes10,
    fastest: fastestTimes10,
    fastestWait,
    fastWait,
    safeLow: safeLowTimes10,
    safeLowWait,
    speed,
  } =
    // await response.json()
    {
      avgWait: 1,
      block_time: 0.5,
      blockNum: 1,
      fast: estimateGasGdripTimes10,
      fastest: estimateGasGdripTimes10,
      fastestWait: 0.1,
      fastWait: 0.1,
      safeLow: estimateGasGdripTimes10,
      safeLowWait: 1,
      speed: 0.1,
    }
  const [average, fast, fastest, safeLow] = [
    // averageTimes10,
    estimateGasGdripTimes10,
    fastTimes10,
    fastestTimes10,
    safeLowTimes10,
  ].map(price => new BigNumber(price).div(10).toNumber())

  const basicEstimates = {
    average,
    avgWait,
    blockTime,
    blockNum,
    fast,
    fastest,
    fastestWait,
    fastWait,
    safeLow,
    safeLowWait,
    speed,
  }

  const timeRetrieved = Date.now()
  saveLocalStorageData(basicEstimates, 'BASIC_GAS_AND_TIME_API_ESTIMATES')
  saveLocalStorageData(
    timeRetrieved,
    'BASIC_GAS_AND_TIME_API_ESTIMATES_LAST_RETRIEVED'
  )
  dispatch(setBasicApiEstimatesLastRetrieved(timeRetrieved))

  return basicEstimates
}

function extrapolateY({ higherY, lowerY, higherX, lowerX, xForExtrapolation }) {
  higherY = new BigNumber(higherY, 10)
  lowerY = new BigNumber(lowerY, 10)
  higherX = new BigNumber(higherX, 10)
  lowerX = new BigNumber(lowerX, 10)
  xForExtrapolation = new BigNumber(xForExtrapolation, 10)
  const slope = higherY.minus(lowerY).div(higherX.minus(lowerX))
  const newTimeEstimate = slope
    .times(higherX.minus(xForExtrapolation))
    .minus(higherY)
    .negated()

  return Number(newTimeEstimate.toPrecision(10))
}

function getRandomArbitrary(min, max) {
  min = new BigNumber(min, 10)
  max = new BigNumber(max, 10)
  const random = new BigNumber(String(Math.random()), 10)
  return new BigNumber(random.times(max.minus(min)).plus(min)).toPrecision(10)
}

function calcMedian(list) {
  const medianPos =
    (Math.floor(list.length / 2) + Math.ceil(list.length / 2)) / 2
  return medianPos === Math.floor(medianPos)
    ? (list[medianPos - 1] + list[medianPos]) / 2
    : list[Math.floor(medianPos)]
}

function quartiles(data) {
  const lowerHalf = data.slice(0, Math.floor(data.length / 2))
  const upperHalf = data.slice(
    Math.floor(data.length / 2) + (data.length % 2 === 0 ? 0 : 1)
  )
  const median = calcMedian(data)
  const lowerQuartile = calcMedian(lowerHalf)
  const upperQuartile = calcMedian(upperHalf)
  return {
    median,
    lowerQuartile,
    upperQuartile,
  }
}

function inliersByIQR(data, prop) {
  const { lowerQuartile, upperQuartile } = quartiles(
    data.map(d => (prop ? d[prop] : d))
  )
  const IQR = upperQuartile - lowerQuartile
  const lowerBound = lowerQuartile - 1.5 * IQR
  const upperBound = upperQuartile + 1.5 * IQR
  return data.filter(d => {
    const value = prop ? d[prop] : d
    return value >= lowerBound && value <= upperBound
  })
}

export function fetchGasEstimates(blockTime) {
  return (dispatch, getState) => {
    const state = getState()

    if (!isEthereumNetwork(state)) {
      return Promise.resolve(null)
    }

    const {
      priceAndTimeEstimatesLastRetrieved,
      priceAndTimeEstimates,
    } = state.gas
    const timeLastRetrieved =
      priceAndTimeEstimatesLastRetrieved ||
      loadLocalStorageData('GAS_API_ESTIMATES_LAST_RETRIEVED') ||
      0

    dispatch(gasEstimatesLoadingStarted())

    const promiseToFetch =
      Date.now() - timeLastRetrieved > 75000
        ? fetch('https://ethgasstation.info/json/predictTable.json', {
            headers: {},
            referrer: 'http://ethgasstation.info/json/',
            referrerPolicy: 'no-referrer-when-downgrade',
            body: null,
            method: 'GET',
            mode: 'cors',
          })
            .then(r => r.json())
            .then(r => {
              const estimatedPricesAndTimes = r.map(
                ({ expectedTime, expectedWait, gasprice }) => ({
                  expectedTime,
                  expectedWait,
                  gasprice,
                })
              )
              const estimatedTimeWithUniquePrices = uniqBy(
                ({ expectedTime }) => expectedTime,
                estimatedPricesAndTimes
              )

              const withSupplementalTimeEstimates = flatten(
                estimatedTimeWithUniquePrices.map(
                  ({ expectedWait, gasprice }, i, arr) => {
                    const next = arr[i + 1]
                    if (!next) {
                      return [{ expectedWait, gasprice }]
                    } else {
                      const supplementalPrice = getRandomArbitrary(
                        gasprice,
                        next.gasprice
                      )
                      const supplementalTime = extrapolateY({
                        higherY: next.expectedWait,
                        lowerY: expectedWait,
                        higherX: next.gasprice,
                        lowerX: gasprice,
                        xForExtrapolation: supplementalPrice,
                      })
                      const supplementalPrice2 = getRandomArbitrary(
                        supplementalPrice,
                        next.gasprice
                      )
                      const supplementalTime2 = extrapolateY({
                        higherY: next.expectedWait,
                        lowerY: supplementalTime,
                        higherX: next.gasprice,
                        lowerX: supplementalPrice,
                        xForExtrapolation: supplementalPrice2,
                      })
                      return [
                        { expectedWait, gasprice },
                        {
                          expectedWait: supplementalTime,
                          gasprice: supplementalPrice,
                        },
                        {
                          expectedWait: supplementalTime2,
                          gasprice: supplementalPrice2,
                        },
                      ]
                    }
                  }
                )
              )
              const withOutliersRemoved = inliersByIQR(
                withSupplementalTimeEstimates.slice(0).reverse(),
                'expectedWait'
              ).reverse()
              const timeMappedToSeconds = withOutliersRemoved.map(
                ({ expectedWait, gasprice }) => {
                  const expectedTime = new BigNumber(expectedWait)
                    .times(Number(blockTime), 10)
                    .toNumber()
                  return {
                    expectedTime,
                    gasprice: new BigNumber(gasprice, 10).toNumber(),
                  }
                }
              )

              const timeRetrieved = Date.now()
              dispatch(setApiEstimatesLastRetrieved(timeRetrieved))
              saveLocalStorageData(
                timeRetrieved,
                'GAS_API_ESTIMATES_LAST_RETRIEVED'
              )
              saveLocalStorageData(timeMappedToSeconds, 'GAS_API_ESTIMATES')

              return timeMappedToSeconds
            })
        : Promise.resolve(
            priceAndTimeEstimates.length
              ? priceAndTimeEstimates
              : loadLocalStorageData('GAS_API_ESTIMATES')
          )

    return promiseToFetch.then(estimates => {
      dispatch(setPricesAndTimeEstimates(estimates))
      dispatch(gasEstimatesLoadingFinished())
    })
  }
}

export function setCustomGasPriceForRetry(newPrice) {
  return dispatch => {
    if (newPrice !== '0x0') {
      dispatch(setCustomGasPrice(newPrice))
    } else {
      dispatch(
        setCustomGasPrice(
          addCurrencies(newPrice, '0x1', {
            aBase: 16,
            bBase: 16,
            toNumericBase: 'hex',
          })
        )
      )
    }
  }
}

export function setBasicGasEstimateData(basicGasEstimateData) {
  return {
    type: SET_BASIC_GAS_ESTIMATE_DATA,
    value: basicGasEstimateData,
  }
}

export function setPricesAndTimeEstimates(estimatedPricesAndTimes) {
  return {
    type: SET_PRICE_AND_TIME_ESTIMATES,
    value: estimatedPricesAndTimes,
  }
}

export function setCustomGasPrice(newPrice) {
  return {
    type: SET_CUSTOM_GAS_PRICE,
    value: newPrice,
  }
}

export function setCustomGasLimit(newLimit) {
  return {
    type: SET_CUSTOM_GAS_LIMIT,
    value: newLimit,
  }
}

export function setCustomGasTotal(newTotal) {
  return {
    type: SET_CUSTOM_GAS_TOTAL,
    value: newTotal,
  }
}

export function setCustomGasErrors(newErrors) {
  return {
    type: SET_CUSTOM_GAS_ERRORS,
    value: newErrors,
  }
}

export function setApiEstimatesLastRetrieved(retrievalTime) {
  return {
    type: SET_API_ESTIMATES_LAST_RETRIEVED,
    value: retrievalTime,
  }
}

export function setBasicApiEstimatesLastRetrieved(retrievalTime) {
  return {
    type: SET_BASIC_API_ESTIMATES_LAST_RETRIEVED,
    value: retrievalTime,
  }
}

export function setBasicPriceEstimatesLastRetrieved(retrievalTime) {
  return {
    type: SET_BASIC_PRICE_ESTIMATES_LAST_RETRIEVED,
    value: retrievalTime,
  }
}

export function resetCustomGasState() {
  return { type: RESET_CUSTOM_GAS_STATE }
}

export function resetCustomGasData() {
  return { type: RESET_CUSTOM_GAS_DATA }
}
