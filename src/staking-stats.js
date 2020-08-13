const Web3 = require('web3');
const { toBN } = new Web3().utils;
const log = require('./log');
const fetch = require('node-fetch');
const { hex, getLastProcessedBlock, flattenEvent, sleep } = require('./utils');
const {
  Stake,
  Reward,
  Cover,
  StakerSnapshot,
  StakingStatsSnapshot,
  WithdrawnReward,
} = require('./models');
const { chunk, insertManyIgnoreDuplicates, datesRange } = require('./utils');

const BN = new Web3().utils.BN;

const STAKING_START_DATE = new Date('06-30-2020');
const DAY_IN_SECONDS = 60 * 60 * 24;

class StakingStats {
  constructor (nexusContractLoader, web3, annualizedReturnsDaysInterval, etherscanAPIKey) {
    this.nexusContractLoader = nexusContractLoader;
    this.web3 = web3;
    this.annualizedReturnsDaysInterval = annualizedReturnsDaysInterval;
    this.etherscanAPIKey = etherscanAPIKey;
  }

  async getGlobalAggregatedStats () {

    const globalAggregatedStats = await StakingStatsSnapshot.findOne().sort({ latestBlockProcessed: -1 });
    const tokenPrice = await this.getCurrentTokenPrice('DAI');
    const stats = {
      totalStaked: getUSDValue(new BN(globalAggregatedStats.totalStaked), tokenPrice),
      coverPurchased: getUSDValue(new BN(globalAggregatedStats.coverPurchased), tokenPrice),
      totalRewards: getUSDValue(new BN(globalAggregatedStats.totalRewards), tokenPrice),
      averageReturns: globalAggregatedStats.averageReturns,
      createdAt: globalAggregatedStats.createdAt,
      latestBlockProcessed: globalAggregatedStats.latestBlockProcessed,
    };
    return stats;
  }

  async getStakerStats (staker) {
    const annualizedDaysInterval = this.annualizedReturnsDaysInterval;
    const pooledStaking = this.nexusContractLoader.instance('PS');
    const withdrawnRewards = await WithdrawnReward.find({ staker });

    const withdrawAmounts = withdrawnRewards.map(withdrawnReward => new BN(withdrawnReward.amount));
    const totalWithdrawnAmounts = withdrawAmounts.reduce((a, b) => a.add(b), new BN('0'));
    const currentReward = await pooledStaking.stakerReward(staker);
    const totalRewards = totalWithdrawnAmounts.add(currentReward).toString();

    const dailyStakerSnapshots = await StakerSnapshot
      .find({ address: staker })
      .sort({ timestamp: -1 })
      .limit(annualizedDaysInterval);

    dailyStakerSnapshots.reverse();
    let annualizedReturns;
    if (dailyStakerSnapshots.length >= this.annualizedReturnsDaysInterval) {
      annualizedReturns = stakerAnnualizedReturns(dailyStakerSnapshots, currentReward, withdrawnRewards, annualizedDaysInterval);
    } else {
      log.warn(`Insufficient ${dailyStakerSnapshots.length} daily staker snapshots to compute annualized returns for member ${staker}. Required: ${this.annualizedReturnsDaysInterval}`);
    }

    return { totalRewards, annualizedReturns };
  }

  async getContractStats (contractAddress) {
    const rewards = await Reward.find({ contractAddress });

    const MIN_COVERS_COUNT = 5;
    if (rewards.length < MIN_COVERS_COUNT) {
      return {
        error: 'Not enough historical info.',
      };
    }
    const timestamps = rewards.map(r => r.timestamp);

    const startTimestamp = Math.min(...timestamps);
    const currentStake = await this.getContractStake(contractAddress);
    const endTimestamp = Math.round(new Date().getTime() / 1000);
    const periodInSeconds = endTimestamp - startTimestamp;

    const periodInDays = periodInSeconds / DAY_IN_SECONDS;
    const startingStake = parseInt(rewards.find(r => r.timestamp === startTimestamp).contractStake);

    const averageStake = (parseInt(currentStake.toString()) + startingStake) / 2;
    const rewardSumBN = rewards.map(reward => new BN(reward.amount)).reduce((a, b) => a.add(b), new BN('0'));
    const rewardSum = parseInt(rewardSumBN.toString());

    const apy = (1 + rewardSum / averageStake) ^ (365 / periodInDays) - 1;
    return { annualizedReturns: apy };
  }

  async syncStakingStats () {
    log.info(`Syncing StakingStatsSnapshot..`);
    const latestAggregatedStats = await StakingStatsSnapshot.findOne().sort({ latestBlockProcessed: -1 });
    const fromBlock = latestAggregatedStats ? latestAggregatedStats.latestBlockProcessed + 1 : 0;
    log.info(`Computing global aggregated stats from block ${fromBlock}`);
    const latestBlockProcessed = await this.web3.eth.getBlockNumber();
    log.info(`Latest block being processed: ${latestBlockProcessed}`);

    const [totalRewards, totalStaked, coverPurchased] = await Promise.all([
      this.syncTotalRewards(fromBlock),
      this.syncTotalStaked(fromBlock),
      this.syncTotalCoverPurchases(fromBlock),
    ]);
    const averageReturns = await this.computeGlobalAverageReturns();
    const newValues = {
      totalStaked: totalStaked.toString(),
      totalRewards: totalRewards.toString(),
      coverPurchased: coverPurchased.toString(),
      averageReturns,
      latestBlockProcessed,
      createdAt: new Date(),
    };

    log.info(`Storing GlobalAggregatedStats values: ${JSON.stringify(newValues)}`);
    await StakingStatsSnapshot.create(newValues);
  }

  async computeGlobalAverageReturns () {

    const startTimestamp = (new Date().getTime() - this.annualizedReturnsDaysInterval * 24 * 60 * 60 * 1000) / 1000;
    log.info(`Computing averageReturns starting with rewards from ${new Date(startTimestamp).toISOString()}`);
    const latestRewardedEvents = await Reward
      .find()
      .where('timestamp').gt(startTimestamp);

    const latestRewards = latestRewardedEvents.map(event => new BN(event.amount));
    const totalLatestReward = latestRewards.reduce((a, b) => a.add(b), new BN('0'));

    const latest = await StakerSnapshot
      .findOne()
      .sort({ timestamp: -1 });

    if (!latest) {
      return undefined;
    }

    const latestTimestamp = latest.timestamp;
    const dailyStakerSnapshotForLastDay = await StakerSnapshot
      .find()
      .sort({ timestamp: -1 })
      .where('timestamp').eq(latestTimestamp);

    const currentGlobalDeposit = dailyStakerSnapshotForLastDay
      .map(data => new BN(data.deposit))
      .reduce((a, b) => a.add(b), new BN('0'));

    const averageReturns = parseInt(totalLatestReward.toString()) / parseInt(currentGlobalDeposit.toString());
    return averageReturns;
  }

  async syncTotalRewards (fromBlock) {

    log.info(`Syncing Rewarded events from block ${fromBlock}..`);
    const newRewardedEvents = await this.getRewardedEvents(fromBlock);
    log.info(`Detected ${newRewardedEvents.length} new Rewarded events.`);
    const flattenedRewardedEvents = newRewardedEvents.map(flattenEvent);

    await Promise.all(flattenedRewardedEvents.map(async event => {
      const block = await this.web3.eth.getBlock(event.blockNumber);
      event.timestamp = block.timestamp;
    }));

    await insertManyIgnoreDuplicates(Reward, flattenedRewardedEvents);

    const rewardedEvents = await Reward.find();
    const rewardValues = rewardedEvents.map(event => new BN(event.amount));
    const totalRewards = rewardValues.reduce((a, b) => a.add(b), new BN('0'));
    return totalRewards;
  }

  async syncTotalStaked (fromBlock) {

    log.info(`Syncing Staked events from block ${fromBlock}..`);
    const newStakedEvents = await this.getStakedEvents(fromBlock);
    log.info(`Detected ${newStakedEvents.length} new Staked events.`);
    const flattenedStakedEvents = newStakedEvents.map(flattenEvent);
    await insertManyIgnoreDuplicates(Stake, flattenedStakedEvents);

    const stakedEvents = await Stake.find();
    const contractSet = new Set();
    for (const stakedEvent of stakedEvents) {
      contractSet.add(stakedEvent.contractAddress);
    }
    const contractList = Array.from(contractSet);
    log.info(`A set of ${contractList.length} contracts currently have stakes.`);
    const contractStakes = await Promise.all(contractList.map(contractAddress => {
      try {
        return this.getContractStake(contractAddress);
      } catch (e) {
        log.error(`Failed to fetch contractStake for ${contractAddress}`);
        throw e;
      }
    }));

    const totalStaked = contractStakes.reduce((a, b) => a.add(b), new BN('0'));
    return totalStaked;
  }

  async syncTotalCoverPurchases (fromBlock) {
    const newCoverDetailsEvents = await this.getCoverDetailsEvents(fromBlock);
    log.info(`Detected ${newCoverDetailsEvents.length} new CoverDetailsEvent events.`);
    const covers = newCoverDetailsEvents.map(flattenEvent).map(event => {
      return {
        coverId: event.cid,
        contractAddress: event.scAdd,
        sumAssured: event.sumAssured,
        expiry: event.expiry,
        premium: event.premium,
        premiumNXM: event.premiumNXM,
        currency: event.curr,

        blockHash: event.blockHash,
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        transactionHash: event.transactionHash,
      };
    });
    await insertManyIgnoreDuplicates(Cover, covers);

    const coverDetailsEvents = await Cover.find();
    const premiumNXMValues = coverDetailsEvents.map(event => new BN(event.premiumNXM));
    const totalNXMCoverPurchaseValue = premiumNXMValues.reduce((a, b) => a.add(b), new BN('0'));
    return totalNXMCoverPurchaseValue;
  }

  async syncWithdrawnRewards () {
    log.info(`Syncing RewardWithdrawn..`);

    const fromBlock = await getLastProcessedBlock(WithdrawnReward);
    log.info(`Starting from block ${fromBlock}`);
    const rewardWithdrawnEvents = await this.getRewardWithdrawn(fromBlock);
    await Promise.all(rewardWithdrawnEvents.map(async event => {
      const block = await this.web3.eth.getBlock(event.blockNumber);
      event.timestamp = block.timestamp;
    }));
    const flattenedEvents = rewardWithdrawnEvents.map(flattenEvent);
    log.info(`Detected ${rewardWithdrawnEvents.length} new RewardWithdrawn events.`);
    await insertManyIgnoreDuplicates(WithdrawnReward, flattenedEvents);
  }

  async syncStakerSnapshots () {
    log.info(`Syncing daily staker deposits..`);
    const allStakedEvents = await Stake.find();
    if (allStakedEvents.length === 0) {
      log.info(`No stakes recorded. Skipping syncing staker snapshot sync until that is completed.`);
      return;
    }

    const allStakers = Array.from(new Set(allStakedEvents.map(event => event.staker)));
    log.info(`There are ${allStakers.length} stakers to sync.`);

    const latestStakerSnapshot = await StakerSnapshot.findOne().sort({ timestamp: -1 });

    const startDate = latestStakerSnapshot ? new Date(latestStakerSnapshot.timestamp) : STAKING_START_DATE;
    const endDate = new Date();
    endDate.setHours(0, 0, 0, 0);

    log.info(JSON.stringify({ startDate, endDate }));
    const dates = datesRange(startDate, endDate);
    log.info(`Processing range: ${JSON.stringify(dates)}`);

    let blockNumbersByTimestamp = {};
    if (dates.length > 1) {
      log.info(`Historical data is missing for ${dates.length - 1}. Fetching past block numbers to process.`);
      blockNumbersByTimestamp = await this.getBlockNumbersByTimestamps(dates.map(d => d.getTime()));
    }

    const latestBlock = await this.web3.eth.getBlock('latest');
    log.info(`For today ${endDate} overriding with the latest block number: ${latestBlock.number}`);
    blockNumbersByTimestamp[endDate] = latestBlock.number;

    for (const date of dates) {
      const blockNumber = blockNumbersByTimestamp[date.getTime()];
      log.info(`Syncing for date ${date} and block ${blockNumber}`);
      await this.syncStakerSnapshotsForBlock(allStakers, blockNumber, date);
    }
  }

  async syncStakerSnapshotsForBlock (allStakers, blockNumber, date) {

    const chunkSize = 50;
    const chunks = chunk(allStakers, chunkSize);
    log.info(`To be processed in ${chunks.length} chunks of max size ${chunkSize}`);

    const pooledStaking = this.nexusContractLoader.instance('PS');
    const allStakerSnapshots = [];
    for (const chunk of chunks) {
      log.info(`Processing staker chunk of size ${chunk.length} for ${blockNumber} and date ${date}`);
      const stakerSnapshot = await Promise.all(chunk.map(async staker => {
        const [deposit, reward] = await Promise.all([
          pooledStaking.stakerDeposit(staker),
          pooledStaking.stakerReward(staker),
        ]);
        return { staker, deposit, reward };
      }));
      allStakerSnapshots.push(...stakerSnapshot);
    }
    const today = date;
    // normalize to midnight
    today.setHours(0, 0, 0, 0);
    const createdAt = new Date();
    const dailyStakerSnapshotRecords = allStakerSnapshots.map(({ staker, deposit, reward }) => {
      return {
        address: staker,
        deposit: deposit.toString(),
        reward: reward.toString(),
        timestamp: today.getTime(),
        createdAt: createdAt };
    });

    log.info(`Storing ${dailyStakerSnapshotRecords.length} daily staker deposits.`);
    await insertManyIgnoreDuplicates(StakerSnapshot, dailyStakerSnapshotRecords);
  }

  async getBlockNumbersByTimestamps (timestamps) {

    const blockNumberByTimestamp = {};
    const ETHERSCAN_REQ_PER_SECOND = 5;
    const chunks = chunk(timestamps, ETHERSCAN_REQ_PER_SECOND);
    for (const chunk of chunks) {
      log.info(`Fetching block numbers for timestamps: ${JSON.stringify(chunk)}`);
      await Promise.all(chunk.map(async timestamp => {
        const blockNumber = await this.getBlockNumberByTimestamp(timestamp);
        blockNumberByTimestamp[timestamp] = blockNumber;
      }));
      await sleep(1000);
    }
    return blockNumberByTimestamp;
  }

  async getBlockNumberByTimestamp (timestampInMillis) {
    const timestamp = Math.floor(timestampInMillis / 1000);
    const url = `https://api.etherscan.io/api?module=block&action=getblocknobytime&timestamp=${timestamp}&closest=after&apikey=${this.etherscanAPIKey}`;
    const { result, message } = await fetch(url).then(res => res.json());
    if (message !== 'OK') {
      throw new Error(`${message}: ${result}`);
    }
    return parseInt(result);
  }

  async getContractStake (contractAddress) {
    const pooledStaking = this.nexusContractLoader.instance('PS');
    const stake = await pooledStaking.contractStake(contractAddress);
    return stake;
  }

  async getStakedEvents (fromBlock) {
    const pooledStaking = this.nexusContractLoader.instance('PS');
    const stakedEvents = await pooledStaking.getPastEvents('Staked', {
      fromBlock,
    });
    return stakedEvents;
  }

  async getRewardedEvents (fromBlock) {
    const pooledStaking = this.nexusContractLoader.instance('PS');
    const rewardedEvents = await pooledStaking.getPastEvents('Rewarded', {
      fromBlock,
    });
    return rewardedEvents;
  }

  async getRewardWithdrawn (fromBlock) {
    const pooledStaking = this.nexusContractLoader.instance('PS');
    const rewardWithdrawnEvents = await pooledStaking.getPastEvents('RewardWithdrawn', {
      fromBlock,
    });
    return rewardWithdrawnEvents;
  }

  async getCoverDetailsEvents (fromBlock) {
    const quotationData = this.nexusContractLoader.instance('QD');
    const coverDetailsEvents = await quotationData.getPastEvents('CoverDetailsEvent', {
      fromBlock,
    });
    return coverDetailsEvents;
  }

  async getCurrentTokenPrice (currency) {
    const mcr = this.nexusContractLoader.instance('MC');
    const tokenPrice = mcr.calculateTokenPrice(hex(currency));
    return tokenPrice;
  }
}

/**
 * Uses the staker data snapshots for the last annualizedDaysInterval days to compute
 * the rewards gained by the user until the present time by calculating the difference between the snapshot
 * reward value at the start of the interval, the current stored reward value and adding to that all rewardWithdrawn
 * values in the time interval.
 *
 * Computes the average deposit from all the deposit values in latestStakerSnapshots.
 *
 * @param latestStakerSnapshots
 * @param currentReward
 * @param rewardWithdrawnEvents
 * @param annualizedDaysInterval
 * @returns {*}
 */
function stakerAnnualizedReturns (latestStakerSnapshots, currentReward, rewardWithdrawnEvents, annualizedDaysInterval) {

  if (latestStakerSnapshots.length === 0) {
    return undefined;
  }

  const firstStakerSnapshot = latestStakerSnapshots[0];
  const startTime = firstStakerSnapshot.createdAt.getTime();
  const rewardsPostStartTime = rewardWithdrawnEvents
    .filter(rewardEvent => rewardEvent.timestamp * 1000 >= startTime)
    .map(event => new BN(event.returnValues.amount));

  const storedRewardDifference = currentReward.sub(new BN(firstStakerSnapshot.reward));
  const sumOfRewardsPerInterval = rewardsPostStartTime.reduce((a, b) => a.add(b), storedRewardDifference);
  const averageDeposit = latestStakerSnapshots
    .map(stakerSnapshot => new BN(stakerSnapshot.deposit))
    .reduce((a, b) => a.add(b), new BN('0')).div(new BN(latestStakerSnapshots.length));

  const exponent = 365 / annualizedDaysInterval;

  /**
   *  (sumOfRewardsPerInterval / averageDeposit + 1) ^ ( 365 / annualizedDaysInterval) -1;
   * @type {number}
   */
  const annualizedReturns = (parseInt(sumOfRewardsPerInterval.toString()) / parseInt(averageDeposit.toString()) + 1) ** exponent - 1;
  return annualizedReturns;
}

/**
 * @param nxmPrice {string}
 * @param daiPrice {string}
 * @return {string}
 */
function getUSDValue (nxmPrice, daiPrice) {

  const wad = toBN(1e18);
  const nxmPriceBN = toBN(nxmPrice);
  const nxmInUSD = daiPrice.div(wad);

  return nxmPriceBN.div(wad).mul(nxmInUSD).toString();
}

module.exports = StakingStats;
