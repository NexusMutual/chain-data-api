const Web3 = require('web3');
const { toBN } = new Web3().utils;
const log = require('./log');
const { hex, getLastProcessedBlock } = require('./utils');
const {
  Stake,
  Reward,
  Cover,
  StakerSnapshot,
  StakingStatsSnapshot,
  WithdrawnReward,
} = require('./models');
const { chunk, insertManyIgnoreDuplicates } = require('./utils');

const BN = new Web3().utils.BN;

class StakingStats {
  constructor (nexusContractLoader, web3, annualizedReturnsDaysInterval) {
    this.nexusContractLoader = nexusContractLoader;
    this.web3 = web3;
    this.annualizedReturnsDaysInterval = annualizedReturnsDaysInterval;
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
    const flattenedCoverDetailsEvents = newCoverDetailsEvents.map(flattenEvent);
    await insertManyIgnoreDuplicates(Cover, flattenedCoverDetailsEvents);

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
    const allStakers = Array.from(new Set(allStakedEvents.map(event => event.staker)));
    log.info(`There are ${allStakers.length} stakers to sync.`);
    const chunkSize = 50;
    const chunks = chunk(allStakers, chunkSize);
    log.info(`To be processed in ${chunks.length} chunks of max size ${chunkSize}`);

    const pooledStaking = this.nexusContractLoader.instance('PS');
    const allStakerSnapshots = [];
    for (const chunk of chunks) {
      const stakerSnapshot = await Promise.all(chunk.map(async staker => {
        const [deposit, reward] = await Promise.all([
          pooledStaking.stakerDeposit(staker),
          pooledStaking.stakerReward(staker),
        ]);
        return { staker, deposit, reward };
      }));
      allStakerSnapshots.push(...stakerSnapshot);
    }

    const today = new Date();
    // normalize to midnight
    today.setHours(0, 0, 0, 0);
    const fetchedDate = new Date();
    const dailyStakerSnapshotRecords = allStakerSnapshots.map(({ staker, deposit, reward }) => {
      return {
        address: staker,
        deposit: deposit.toString(),
        reward: reward.toString(),
        timestamp: today.getTime(),
        fetchedDate: fetchedDate };
    });

    log.info(`Storing ${dailyStakerSnapshotRecords.length} daily staker deposits.`);
    await insertManyIgnoreDuplicates(StakerSnapshot, dailyStakerSnapshotRecords);
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

function flattenEvent (event) {
  return { ...event, ...event.returnValues };
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
  const startTime = firstStakerSnapshot.fetchedDate.getTime();
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
