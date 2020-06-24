const Web3 = require('web3');
const log = require('./log');
const { hex } = require('./utils');

const OverallAggregatedStats = require('./models/overall-aggregated-stats');
const StakedEvent = require('./models/staked-event');
const RewardedEvent = require('./models/rewarded-event');
const CoverDetailsEvent = require('./models/cover-details-event');
const DailyStakerDeposit = require('./models/daily-staker-deposit');
const { chunk } = require('./utils');

const BN = new Web3().utils.BN;

class ChainDataAggregator {
  constructor(versionData) {
    this.versionData = versionData;
  }

  async getOverallAggregatedStats() {
    return await OverallAggregatedStats.findOne();
  }

  async getMemberAggregatedStats(member) {
    const pooledStaking = this.versionData.instance('PS');
    const rewardWithdrawnEvents = await pooledStaking.getPastEvents('RewardWithdrawn', {
      filter: {
        staker: member,
      }
    })

    const withdrawAmounts = rewardWithdrawnEvents.map(event => event.returnValues.amount);
    const totalWithdrawnAmounts = withdrawAmounts.reduce((a, b) => a.add(b), new BN('0'));
    const currentReward = await pooledStaking.stakerReward(member);
    const totalRewards = totalWithdrawnAmounts.add(currentReward).toString();
    return { totalRewards };
  }

  async syncOverallAggregateStats() {
    const aggregatedStats = await OverallAggregatedStats.findOne();
    let fromBlock;
    if (!aggregatedStats) {
      fromBlock = 0;
    } else {
      fromBlock = aggregatedStats.lastBlockProcessed + 1;
    }
    log.info(`Computing overall aggregated stats from block ${fromBlock}`);
    const latestBlockProcessed = await this.versionData.web3.eth.getBlockNumber();
    log.info(`Latest block being processed: ${latestBlockProcessed}`);

    const [totalRewards, totalStaked, coverPurchased ] = await Promise.all([
      this.syncTotalRewards(fromBlock),
      this.syncTotalStaked(fromBlock),
      this.syncTotalCoverPurchases(fromBlock),
    ])

    const newValues = {
      totalStaked: totalStaked.toString(),
      totalRewards: totalRewards.toString(),
      coverPurchased: coverPurchased.toString(),
      latestBlockProcessed
    };
    log.info(`Storing OverallAggregatedStats values: ${JSON.stringify(newValues)}`);
    await OverallAggregatedStats.updateOne({}, newValues, { upsert: true });
  }

  async syncTotalRewards(fromBlock) {

    log.info(`Syncing Rewarded events..`);
    const newRewardedEvents = await this.getRewardedEvents(fromBlock);
    log.info(`Detected ${newRewardedEvents.length} new events.`);
    const flattenedRewardedEvents = newRewardedEvents.map(flattenEvent);
    await RewardedEvent.insertMany(flattenedRewardedEvents);

    const rewardedEvents = await RewardedEvent.find();
    const rewardValues = rewardedEvents.map(event => new BN(event.amount));
    const totalRewards = rewardValues.reduce((a, b) => a.add(b), new BN('0'));
    return totalRewards;
  }

  async syncTotalStaked(fromBlock) {

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
    log.info(`A set of ${contractList.length} contracts currently have stakes.`)
    const contractStakes = await Promise.all(contractList.map(contractAddress => {
      try {
        return this.getContractStake(contractAddress)
      } catch (e) {
        log.error(`Failed to fetch contractStake for ${contractAddress}`);
        throw e;
      }
    }));

    const totalStaked = contractStakes.reduce((a, b) => a.add(b), new BN('0'));
    return totalStaked;
  }

  async syncTotalCoverPurchases(fromBlock) {
    const newCoverDetailsEvents = await this.getCoverDetailsEvents(fromBlock);
    log.info(`Detected ${newCoverDetailsEvents.length} new events.`);
    const flattenedCoverDetailsEvents = newCoverDetailsEvents.map(flattenEvent);
    await CoverDetailsEvent.insertMany(flattenedCoverDetailsEvents);

    const coverDetailsEvents = await CoverDetailsEvent.find();
    const premiumNXMValues = coverDetailsEvents.map(event => new BN(event.premiumNXM));
    const totalNXMCoverPurchaseValue = premiumNXMValues.reduce((a, b) => a.add(b), new BN('0'));
    return totalNXMCoverPurchaseValue;
  }


  async syncDailyStakerDeposits() {
    log.info(`Syncing daily staker deposits..`);
    const allStakedEvents = await StakedEvent.find();
    const allStakers = Array.from(new Set(allStakedEvents.map(event => event.staker)));
    log.info(`There are ${allStakers.length} stakers to sync.`);
    const chunkSize = 50;
    const chunks = chunk(allStakers, chunkSize);
    log.info(`To be processed in ${chunks.length} of max size ${chunkSize}`);

    const pooledStaking = this.versionData.instance('PS');
    const allStakerDeposits = [];
    for (const chunk of chunks) {
      const stakerDeposits = await Promise.all(chunk.map(async staker => {
        const deposit = await pooledStaking.stakerDeposit(staker);
        return { staker, deposit };
      }));
      allStakerDeposits.push(...stakerDeposits);
    }

    const today = new Date();
    // normalize to midnight
    today.setHours(0, 0, 0, 0);
    const dailyStakerDepositRecords = allStakerDeposits.map(({ staker, deposit}) => {
      return { address: staker, deposit: deposit.toString(), date: today.toISOString() };
    });

    log.info(`Storing ${dailyStakerDepositRecords.length} daily staker deposits.`);

    try {
      await DailyStakerDeposit.insertMany(dailyStakerDepositRecords, { ordered: false });
    } catch (e) {
      // ignore duplicate errors with code 11000
      if (e.code !== 11000) {
        throw e;
      }
    }
  }

  async getContractStake(contractAddress) {
    const pooledStaking = this.versionData.instance('PS');
    const stake = await pooledStaking.contractStake(contractAddress);
    return stake;
  }

  async getStakedEvents(fromBlock) {
    const pooledStaking = this.versionData.instance('PS');
    const stakedEvents = await pooledStaking.getPastEvents('Staked', {
      fromBlock
    });
    return stakedEvents;
  }

  async getRewardedEvents(fromBlock) {
    const pooledStaking = this.versionData.instance('PS');
    const rewardedEvents = await pooledStaking.getPastEvents('Rewarded', {
      fromBlock
    });
    return rewardedEvents;
  }

  async getCoverDetailsEvents(fromBlock) {
    const quotationData = this.versionData.instance('QD');
    const coverDetailsEvents = await quotationData.getPastEvents('CoverDetailsEvent', {
      fromBlock
    })
    return coverDetailsEvents;
  }

  async getCurrentTokenPrice(currency) {
    const mcr = this.versionData.instance('MC');
    const tokenPrice = mcr.calculateTokenPrice(hex(currency));
    return tokenPrice;
  }
}

async function runForever(f, interval, errorInterval) {
  log.info(`Running forever with interval = ${interval}, errorInterval = ${errorInterval}, startDelay = ${startDelay}`);
  while (true) {
    try {
      await f();
      await sleep(interval);
    } catch (e) {
      log.error(`Failed with ${e.stack}. Restarting in ${errorInterval} ms.`);
      await sleep(errorInterval);
    }
  }
}

function flattenEvent(event) {
  return { ...event, ...event.returnValues }
}


module.exports = ChainDataAggregator
