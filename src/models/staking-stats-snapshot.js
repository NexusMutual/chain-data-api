const mongoose = require('mongoose');

const stakingStatsSnapshotSchema = new mongoose.Schema({
  totalStaked: String,
  coverPurchased: String,
  totalRewards: String,
  averageReturns: String,
  blockNumber: Number,
  createdAt: Date,
});
module.exports = mongoose.model('StakingStatsSnapshot', stakingStatsSnapshotSchema);
