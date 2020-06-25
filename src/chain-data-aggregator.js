const Web3 = require('web3');
const log = require('./log');
const { hex } = require('./utils');

const OverallAggregatedStats = require('./models/overall-aggregated-stats');
const StakedEvent = require('./models/staked-event');
const RewardedEvent = require('./models/rewarded-event');
const CoverDetailsEvent = require('./models/cover-details-event');
const DailyStakerData = require('./models/daily-staker-data');
const { chunk } = require('./utils');

const BN = new Web3().utils.BN;

class ChainDataAggregator {
  constructor (versionData, annualizedReturnsMinDays) {
    this.versionData = versionData;
    this.annualizedReturnsMinDays = annualizedReturnsMinDays;
  }

  async getOverallAggregatedStats () {
    const overallAggregatedStats = await OverallAggregatedStats.findOne();
    return overallAggregatedStats;
  }

  async getMemberAggregatedStats (member, annualizedDaysInterval) {
    const pooledStaking = this.versionData.instance('PS');
    const rewardWithdrawnEvents = await pooledStaking.getPastEvents('RewardWithdrawn', {
      filter: {
        staker: member,
      },
    });

    // TODO: not efficient to fetch these blocks everytime
    await Promise.all(rewardWithdrawnEvents.map(async event => {
      const block = await this.versionData.web3.eth.getBlock(event.blockNumber);
      event.timestamp = block.timestamp;
    }));

    const withdrawAmounts = rewardWithdrawnEvents.map(event => new BN(event.returnValues.amount));
    const totalWithdrawnAmounts = withdrawAmounts.reduce((a, b) => a.add(b), new BN('0'));
    const currentReward = await pooledStaking.stakerReward(member);
    const totalRewards = totalWithdrawnAmounts.add(currentReward).toString();

    const dailyStakerData = await DailyStakerData
      .find({ address: member })
      .sort({ timestamp: -1 })
      .limit(annualizedDaysInterval);

    dailyStakerData.reverse();
    let annualizedReturns;
    if (dailyStakerData.length >= this.annualizedReturnsMinDays) {
      annualizedReturns = stakerAnnualizedReturns(dailyStakerData, currentReward, rewardWithdrawnEvents, annualizedDaysInterval);
    } else {
      log.warn(`Insufficient ${dailyStakerData.length} data points to compute annualized returns for member ${member}. Required: ${this.annualizedReturnsMinDays}`);
    }

    return { totalRewards, annualizedReturns };
  }

  async syncOverallAggregateStats () {
    const aggregatedStats = await OverallAggregatedStats.findOne();
    let fromBlock;
    if (!aggregatedStats) {
      fromBlock = 0;
    } else {
      fromBlock = aggregatedStats.latestBlockProcessed + 1;
    }
    log.info(`Computing overall aggregated stats from block ${fromBlock}`);
    const latestBlockProcessed = await this.versionData.web3.eth.getBlockNumber();
    log.info(`Latest block being processed: ${latestBlockProcessed}`);

    const [totalRewards, totalStaked, coverPurchased] = await Promise.all([
      this.syncTotalRewards(fromBlock),
      this.syncTotalStaked(fromBlock),
      this.syncTotalCoverPurchases(fromBlock),
    ]);
    const averageReturns = await this.computeAverageReturns();
    const newValues = {
      totalStaked: totalStaked.toString(),
      totalRewards: totalRewards.toString(),
      coverPurchased: coverPurchased.toString(),
      averageReturns,
      latestBlockProcessed,
    };

    log.info(`Storing OverallAggregatedStats values: ${JSON.stringify(newValues)}`);
    await OverallAggregatedStats.updateOne({}, newValues, { upsert: true });
  }

  async computeAverageReturns () {

    const startTimestamp = (new Date().getTime() - this.annualizedReturnsMinDays * 24 * 60 * 60 * 1000) / 1000;
    log.info(`Computing averageReturns starting with rewards from ${new Date(startTimestamp).toISOString()}`);
    const latestRewardedEvents = await RewardedEvent
      .find()
      .where('timestamp').gt(startTimestamp);

    const latestRewards = latestRewardedEvents.map(event => new BN(event.amount));
    const totalLatestReward = latestRewards.reduce((a, b) => a.add(b), new BN('0'));

    const latest = await DailyStakerData
      .findOne()
      .sort({ timestamp: -1 });

    if (!latest) {
      return undefined;
    }

    const latestTimestamp = latest.timestamp;
    const dailyStakerDataForLastDay = await DailyStakerData
      .find()
      .sort({ timestamp: -1 })
      .where('timestamp').eq(latestTimestamp);

    const currentOverallDeposit = dailyStakerDataForLastDay
      .map(data => new BN(data.deposit))
      .reduce((a, b) => a.add(b), new BN('0'));

    const averageReturns = parseInt(totalLatestReward.toString()) / parseInt(currentOverallDeposit.toString());
    return averageReturns;
  }

  async syncTotalRewards (fromBlock) {

    log.info(`Syncing Rewarded events..`);
    const newRewardedEvents = await this.getRewardedEvents(fromBlock);
    log.info(`Detected ${newRewardedEvents.length} new events.`);
    const flattenedRewardedEvents = newRewardedEvents.map(flattenEvent);

    await Promise.all(flattenedRewardedEvents.map(async event => {
      const block = await this.versionData.web3.eth.getBlock(event.blockNumber);
      event.timestamp = block.timestamp;
    }));

    await RewardedEvent.insertMany(flattenedRewardedEvents);

    const rewardedEvents = await RewardedEvent.find();
    const rewardValues = rewardedEvents.map(event => new BN(event.amount));
    const totalRewards = rewardValues.reduce((a, b) => a.add(b), new BN('0'));
    return totalRewards;
  }

  async syncTotalStaked (fromBlock) {

    log.info(`Syncing Staked events..`);
    const newStakedEvents = await this.getStakedEvents(fromBlock);
    log.info(`Detected ${newStakedEvents.length} new events.`);
    const flattenedStakedEvents = newStakedEvents.map(flattenEvent);
    await StakedEvent.insertMany(flattenedStakedEvents);

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
    log.info(`Detected ${newCoverDetailsEvents.length} new events.`);
    const flattenedCoverDetailsEvents = newCoverDetailsEvents.map(flattenEvent);
    await CoverDetailsEvent.insertMany(flattenedCoverDetailsEvents);

    const coverDetailsEvents = await CoverDetailsEvent.find();
    const premiumNXMValues = coverDetailsEvents.map(event => new BN(event.premiumNXM));
    const totalNXMCoverPurchaseValue = premiumNXMValues.reduce((a, b) => a.add(b), new BN('0'));
    return totalNXMCoverPurchaseValue;
  }

  async syncDailyStakerData () {
    log.info(`Syncing daily staker deposits..`);
    const allStakedEvents = await StakedEvent.find();
    const allStakers = Array.from(new Set(allStakedEvents.map(event => event.staker)));
    log.info(`There are ${allStakers.length} stakers to sync.`);
    const chunkSize = 50;
    const chunks = chunk(allStakers, chunkSize);
    log.info(`To be processed in ${chunks.length} of max size ${chunkSize}`);

    const pooledStaking = this.versionData.instance('PS');
    const allStakerData = [];
    for (const chunk of chunks) {
      const stakerData = await Promise.all(chunk.map(async staker => {
        const [deposit, reward] = await Promise.all([
          pooledStaking.stakerDeposit(staker),
          pooledStaking.stakerReward(staker),
        ]);
        return { staker, deposit, reward };
      }));
      allStakerData.push(...stakerData);
    }

    const today = new Date();
    // normalize to midnight
    today.setHours(0, 0, 0, 0);
    const fetchedDate = new Date();
    const dailyStakerDataRecords = allStakerData.map(({ staker, deposit, reward }) => {
      return {
        address: staker,
        deposit: deposit.toString(),
        reward: reward.toString(),
        timestamp: today.getTime(),
        fetchedDate: fetchedDate.toISOString() };
    });

    log.info(`Storing ${dailyStakerDataRecords.length} daily staker deposits.`);
    try {
      await DailyStakerData.insertMany(dailyStakerDataRecords, { ordered: false });
    } catch (e) {
      // ignore duplicate errors with code 11000
      if (e.code !== 11000) {
        throw e;
      }
    }
  }

  async getContractStake (contractAddress) {
    const pooledStaking = this.versionData.instance('PS');
    const stake = await pooledStaking.contractStake(contractAddress);
    return stake;
  }

  async getStakedEvents (fromBlock) {
    const pooledStaking = this.versionData.instance('PS');
    const stakedEvents = await pooledStaking.getPastEvents('Staked', {
      fromBlock,
    });
    return stakedEvents;
  }

  async getRewardedEvents (fromBlock) {
    const pooledStaking = this.versionData.instance('PS');
    const rewardedEvents = await pooledStaking.getPastEvents('Rewarded', {
      fromBlock,
    });
    return rewardedEvents;
  }

  async getCoverDetailsEvents (fromBlock) {
    const quotationData = this.versionData.instance('QD');
    const coverDetailsEvents = await quotationData.getPastEvents('CoverDetailsEvent', {
      fromBlock,
    });
    return coverDetailsEvents;
  }

  async getCurrentTokenPrice (currency) {
    const mcr = this.versionData.instance('MC');
    const tokenPrice = mcr.calculateTokenPrice(hex(currency));
    return tokenPrice;
  }
}

function flattenEvent (event) {
  return { ...event, ...event.returnValues };
}

function stakerAnnualizedReturns (latestData, currentReward, rewardWithdrawnEvents, annualizedDaysInterval) {
  if (latestData.length === 0) {
    return undefined;
  }

  const firstStakerData = latestData[0];
  const startTime = new Date(firstStakerData.fetchedDate).getTime();
  const rewardsPostStartTime = rewardWithdrawnEvents
    .filter(rewardEvent => rewardEvent.timestamp * 1000 >= startTime)
    .map(event => new BN(event.returnValues.amount));

  const storedRewardDifference = currentReward.sub(new BN(firstStakerData.reward));
  const sumOfRewardsPerInterval = rewardsPostStartTime.reduce((a, b) => a.add(b), storedRewardDifference);
  const averageDeposit = latestData
    .map(stakerData => new BN(stakerData.deposit))
    .reduce((a, b) => a.add(b), new BN('0')).div(new BN(latestData.length));

  const exponent = 365 / annualizedDaysInterval;

  /**
   *  (sumOfRewardsPerInterval / averageDeposit + 1) ^ ( 365 / annualizedDaysInterval) -1;
   * @type {number}
   */
  const annualizedReturns = (parseInt(sumOfRewardsPerInterval.toString()) / parseInt(averageDeposit.toString()) + 1) ** exponent - 1;
  return annualizedReturns;
}

module.exports = ChainDataAggregator;
