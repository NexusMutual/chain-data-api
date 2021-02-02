const Web3 = require('web3');
const { toBN } = new Web3().utils;
const log = require('./log');
const fetch = require('node-fetch');
const NodeCache = require('node-cache');
const { hex, getLastProcessedBlock, flattenEvent, sleep, to } = require('./utils');
const {
  Stake,
  Reward,
  Cover,
  StakingStatsSnapshot,
  WithdrawnReward,
} = require('./models');
const { chunk, insertManyIgnoreDuplicates, datesRange, addDays, dayUTCFloor } = require('./utils');
const { getWhitelist } = require('./contract-whitelist');

const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';

const BN = new Web3().utils.BN;

const STAKING_START_DATE = dayUTCFloor(new Date('06-31-2020'));
const DAY_IN_SECONDS = 60 * 60 * 24;
const MIN_CONTRACT_RETURNS_ANNUALIZATION_DAYS = 7;

class StakingStats {
  constructor (nexusContractLoader, web3, annualizedReturnsDaysInterval, etherscanAPIKey) {
    this.nexusContractLoader = nexusContractLoader;
    this.web3 = web3;
    this.annualizedReturnsDaysInterval = annualizedReturnsDaysInterval;
    this.etherscanAPIKey = etherscanAPIKey;
    this.blockCache = {};
    this.contractStakeCache = new NodeCache({ stdTTL: 15, checkperiod: 60 });
  }

  async getGlobalStats () {

    const globalAggregatedStats = await StakingStatsSnapshot.findOne().sort({ blockNumber: -1 });
    const tokenPrice = await this.getCurrentTokenPrice(DAI);
    const stats = {
      totalStaked: getUSDValue(new BN(globalAggregatedStats.totalStaked), tokenPrice),
      coverPurchased: getUSDValue(new BN(globalAggregatedStats.coverPurchased), tokenPrice),
      totalRewards: getUSDValue(new BN(globalAggregatedStats.totalRewards), tokenPrice),
      averageReturns: globalAggregatedStats.averageReturns,
      createdAt: globalAggregatedStats.createdAt,
      blockNumber: globalAggregatedStats.blockNumber,
    };
    return stats;
  }

  async getStakerStats (rawStaker) {
    const staker = rawStaker.toLowerCase();
    const pooledStaking = this.nexusContractLoader.instance('PS');
    const withdrawnRewards = await WithdrawnReward.find({ staker });

    const withdrawAmounts = withdrawnRewards.map(withdrawnReward => new BN(withdrawnReward.amount));
    const totalWithdrawnAmounts = withdrawAmounts.reduce((a, b) => a.add(b), new BN('0'));
    const currentReward = await pooledStaking.stakerReward(staker);
    const totalRewards = totalWithdrawnAmounts.add(currentReward).toString();

    return { totalRewards };
  }

  async getContractStats (rawContractAddress) {
    const contractAddress = rawContractAddress.toLowerCase();
    const rewards = await Reward.find({ contractAddress });

    const MIN_COVERS_COUNT = 2;
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

    const periodInDays = Math.max(periodInSeconds / DAY_IN_SECONDS, MIN_CONTRACT_RETURNS_ANNUALIZATION_DAYS);
    const startingStake = parseInt(rewards.find(r => r.timestamp === startTimestamp).contractStake);

    const averageStake = (parseInt(currentStake.toString()) + startingStake) / 2;
    const rewardSumBN = rewards.map(reward => new BN(reward.amount)).reduce((a, b) => a.add(b), new BN('0'));
    const rewardSum = parseInt(rewardSumBN.toString());

    const apy = (1 + rewardSum / averageStake) ** (365 / periodInDays) - 1;
    return { annualizedReturns: apy };
  }

  async getAllContractStats () {
    const whitelist = await getWhitelist();
    const contracts = Object.keys(whitelist);

    log.info(`Fetching contract stats for ${contracts.length} contracts.`);

    const chunkSize = 50;
    const chunks = chunk(contracts, chunkSize);
    log.info(`To be processed in ${chunks.length} chunks of max size ${chunkSize}`);

    const stats = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const contractStats = await Promise.all(chunk.map(async (contract) => {
        const stats = await this.getContractStats(contract);
        return { ...stats, contractAddress: contract };
      }));

      stats.push(...contractStats);
    }

    return stats;
  }

  async syncStakingStats () {
    log.info(`Syncing StakingStatsSnapshot..`);
    const latestAggregatedStats = await StakingStatsSnapshot.findOne().sort({ blockNumber: -1 });
    const fromBlock = latestAggregatedStats ? latestAggregatedStats.blockNumber + 1 : 0;
    log.info(`Computing global aggregated stats from block ${fromBlock}`);
    const blockNumber = await this.web3.eth.getBlockNumber();
    log.info(`Latest block being processed: ${blockNumber}`);

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
      blockNumber,
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

    const pooledStakingNXMBalance = await this.getPooledStakingXMBalance();
    const currentGlobalDeposit = pooledStakingNXMBalance.sub(totalLatestReward);

    const averageReturns = parseInt(totalLatestReward.toString()) / parseInt(currentGlobalDeposit.toString());
    return averageReturns;
  }

  async syncTotalRewards (fromBlock) {

    log.info(`Syncing Rewarded events from block ${fromBlock}..`);
    const newRewardedEvents = await this.getRewardedEvents(fromBlock);
    log.info(`Detected ${newRewardedEvents.length} new Rewarded events.`);
    const flattenedRewardedEvents = newRewardedEvents.map(flattenEvent);

    await Promise.all(flattenedRewardedEvents.map(async event => {
      const block = await this.getBlock(event.blockNumber);
      event.timestamp = block.timestamp;
      event.contractAddress = event.contractAddress.toLowerCase();
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
    flattenedStakedEvents.forEach(e => {
      e.contractAddress = e.contractAddress.toLowerCase();
    });
    await insertManyIgnoreDuplicates(Stake, flattenedStakedEvents);

    const stakedEvents = await Stake.find();
    const contractSet = new Set(stakedEvents.map(event => event.contractAddress));
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
        contractAddress: event.scAdd.toLowerCase(),
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
      const block = await this.getBlock(event.blockNumber);
      event.timestamp = block.timestamp;
    }));
    const flattenedEvents = rewardWithdrawnEvents.map(flattenEvent);
    flattenedEvents.forEach(e => {
      e.staker = e.staker.toLowerCase();
    });
    log.info(`Detected ${rewardWithdrawnEvents.length} new RewardWithdrawn events.`);
    await insertManyIgnoreDuplicates(WithdrawnReward, flattenedEvents);
  }

  async getContractStake (contractAddress) {

    const cachedContractStake = this.contractStakeCache.get(contractAddress);
    if (cachedContractStake) {
      return cachedContractStake;
    }

    const pooledStaking = this.nexusContractLoader.instance('PS');
    const stake = await pooledStaking.contractStake(contractAddress);

    this.contractStakeCache.set(contractAddress, stake);
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

  async getCurrentTokenPrice (asset) {
    const pool = this.nexusContractLoader.instance('P1');
    const tokenPrice = await pool.getTokenPrice(asset);
    return tokenPrice;
  }

  async getPooledStakingXMBalance() {
    const pooledStaking = this.nexusContractLoader.instance('PS');
    const nxm = this.nexusContractLoader.instance('NXMTOKEN');
    const nxmBalance = await nxm.balanceOf(pooledStaking.address);
    return nxmBalance;
  }

  async getBlock (blockNumber) {
    if (!this.blockCache[blockNumber]) {
      this.blockCache[blockNumber] = await this.web3.eth.getBlock(blockNumber);
    }
    return this.blockCache[blockNumber];
  }
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
