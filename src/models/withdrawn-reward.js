const mongoose = require('mongoose');

const withdrawnRewardSchema = new mongoose.Schema({
  staker: { type: String },
  amount: { type: String },
  timestamp: { type: Number },
});

withdrawnRewardSchema.index({ transactionHash: 1, logIndex: 1 }, { unique: true });

module.exports = mongoose.model('WithdrawnReward', withdrawnRewardSchema);
