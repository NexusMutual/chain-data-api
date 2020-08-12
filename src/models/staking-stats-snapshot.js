const mongoose = require('mongoose');

const stakingStatsSnapshotSchema = new mongoose.Schema({
  totalStaked: String,
  coverPurchased: String,
  totalRewards: String,
  averageReturns: String,
  latestBlockProcessed: Number,
  createdAt: Date,
});
module.exports = mongoose.model('StakingStatsSnapshot', stakingStatsSnapshotSchema);
