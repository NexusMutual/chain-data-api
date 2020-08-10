const Web3 = require('web3');
const log = require('./log');
const { hex } = require('./utils');

const GlobalAggregatedStats = require('./models/global-aggregated-stats');
const StakedEvent = require('./models/staked-event');
const RewardedEvent = require('./models/rewarded-event');
const CoverDetailsEvent = require('./models/cover-details-event');
const DailyStakerSnapshot = require('./models/daily-staker-snapshot');
const { chunk, insertManyIgnoreDuplicates } = require('./utils');

const BN = new Web3().utils.BN;

class ChainDataAggregator {
  constructor (nexusContractLoader, web3, annualizedReturnsDaysInterval) {
    this.nexusContractLoader = nexusContractLoader;
    this.web3 = web3;
    this.annualizedReturnsDaysInterval = annualizedReturnsDaysInterval;
  }

  async getGlobalAggregatedStats () {

    const globalAggregatedStats = await GlobalAggregatedStats.findOne();
    const tokenPrice = await this.getCurrentTokenPrice('DAI');
    const stats = {
      totalStaked: getUSDValue(new BN(globalAggregatedStats.totalStaked), tokenPrice),
      coverPurchased: getUSDValue(new BN(globalAggregatedStats.coverPurchased), tokenPrice),
      totalRewards: getUSDValue(new BN(globalAggregatedStats.totalRewards), tokenPrice),
      averageReturns: globalAggregatedStats.averageReturns,
    };
    return stats;
  }

  async getMemberAggregatedStats (member) {
    const annualizedDaysInterval = this.annualizedReturnsDaysInterval;
    const pooledStaking = this.nexusContractLoader.instance('PS');
    const rewardWithdrawnEvents = await pooledStaking.getPastEvents('RewardWithdrawn', {
      filter: {
        staker: member,
      },
    });

    // TODO: not efficient to fetch these blocks everytime
    await Promise.all(rewardWithdrawnEvents.map(async event => {
      const block = await this.web3.eth.getBlock(event.blockNumber);
      event.timestamp = block.timestamp;
    }));

    const withdrawAmounts = rewardWithdrawnEvents.map(event => new BN(event.returnValues.amount));
    const totalWithdrawnAmounts = withdrawAmounts.reduce((a, b) => a.add(b), new BN('0'));
    const currentReward = await pooledStaking.stakerReward(member);
    const totalRewards = totalWithdrawnAmounts.add(currentReward).toString();

    const dailyStakerSnapshots = await DailyStakerSnapshot
      .find({ address: member })
      .sort({ timestamp: -1 })
      .limit(annualizedDaysInterval);

    dailyStakerSnapshots.reverse();
    let annualizedReturns;
    if (dailyStakerSnapshots.length >= this.annualizedReturnsDaysInterval) {
      annualizedReturns = stakerAnnualizedReturns(dailyStakerSnapshots, currentReward, rewardWithdrawnEvents, annualizedDaysInterval);
    } else {
      log.warn(`Insufficient ${dailyStakerSnapshots.length} daily staker snapshots to compute annualized returns for member ${member}. Required: ${this.annualizedReturnsDaysInterval}`);
    }

    return { totalRewards, annualizedReturns };
  }

  async syncGlobalAggregateStats () {
    log.info(`Syncing GlobalAggregateStats..`);
    const aggregatedStats = await GlobalAggregatedStats.findOne();
    const fromBlock = aggregatedStats ? aggregatedStats.latestBlockProcessed + 1 : 0;
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
    };

    log.info(`Storing GlobalAggregatedStats values: ${JSON.stringify(newValues)}`);
    await GlobalAggregatedStats.updateOne({}, newValues, { upsert: true });
  }

  async computeGlobalAverageReturns () {

    const startTimestamp = (new Date().getTime() - this.annualizedReturnsDaysInterval * 24 * 60 * 60 * 1000) / 1000;
    log.info(`Computing averageReturns starting with rewards from ${new Date(startTimestamp).toISOString()}`);
    const latestRewardedEvents = await RewardedEvent
      .find()
      .where('timestamp').gt(startTimestamp);

    const latestRewards = latestRewardedEvents.map(event => new BN(event.amount));
    const totalLatestReward = latestRewards.reduce((a, b) => a.add(b), new BN('0'));

    const latest = await DailyStakerSnapshot
      .findOne()
      .sort({ timestamp: -1 });

    if (!latest) {
      return undefined;
    }

    const latestTimestamp = latest.timestamp;
    const dailyStakerSnapshotForLastDay = await DailyStakerSnapshot
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

    log.info(`Syncing Rewarded events..`);
    const newRewardedEvents = await this.getRewardedEvents(fromBlock);
    log.info(`Detected ${newRewardedEvents.length} new Rewarded events.`);
    const flattenedRewardedEvents = newRewardedEvents.map(flattenEvent);

    await Promise.all(flattenedRewardedEvents.map(async event => {
      const block = await this.web3.eth.getBlock(event.blockNumber);
      event.timestamp = block.timestamp;
    }));

    await insertManyIgnoreDuplicates(RewardedEvent, flattenedRewardedEvents);

    const rewardedEvents = await RewardedEvent.find();
    const rewardValues = rewardedEvents.map(event => new BN(event.amount));
    const totalRewards = rewardValues.reduce((a, b) => a.add(b), new BN('0'));
    return totalRewards;
  }

  async syncTotalStaked (fromBlock) {

    log.info(`Syncing Staked events..`);
    const newStakedEvents = await this.getStakedEvents(fromBlock);
    log.info(`Detected ${newStakedEvents.length} new Staked events.`);
    const flattenedStakedEvents = newStakedEvents.map(flattenEvent);
    await insertManyIgnoreDuplicates(StakedEvent, flattenedStakedEvents);

    const stakedEvents = await StakedEvent.find();
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
    await insertManyIgnoreDuplicates(CoverDetailsEvent, flattenedCoverDetailsEvents);

    const coverDetailsEvents = await CoverDetailsEvent.find();
    const premiumNXMValues = coverDetailsEvents.map(event => new BN(event.premiumNXM));
    const totalNXMCoverPurchaseValue = premiumNXMValues.reduce((a, b) => a.add(b), new BN('0'));
    return totalNXMCoverPurchaseValue;
  }

  async syncDailyStakerSnapshots () {
    log.info(`Syncing daily staker deposits..`);
    const allStakedEvents = await StakedEvent.find();
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
        // toISOString() defaults to UTC timezone
        fetchedDate: fetchedDate.toISOString() };
    });

    log.info(`Storing ${dailyStakerSnapshotRecords.length} daily staker deposits.`);
    await insertManyIgnoreDuplicates(DailyStakerSnapshot, dailyStakerSnapshotRecords);
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
  const startTime = new Date(firstStakerSnapshot.fetchedDate).getTime();
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

function getUSDValue (nxmPrice, daiPrice) {
  const nxmInUSD = daiPrice.div(new BN(1e18.toString()));
  return parseInt(nxmPrice.div(new BN(1e18.toString())).mul(nxmInUSD).toString());
}

module.exports = ChainDataAggregator;
