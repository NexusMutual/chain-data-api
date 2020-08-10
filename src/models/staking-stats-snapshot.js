const mongoose = require('mongoose');

const stakingStatsSnapshotSchema = new mongoose.Schema({
  totalStaked: String,
  coverPurchased: String,
  totalRewards: String,
  averageReturns: String,
  latestBlockProcessed: Number,
});
module.exports = mongoose.model('StakingStatsSnapshot', stakingStatsSnapshotSchema);
