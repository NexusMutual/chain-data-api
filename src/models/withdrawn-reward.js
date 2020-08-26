const mongoose = require('mongoose');

const withdrawnRewardSchema = new mongoose.Schema({
  staker: { type: String },
  amount: { type: String },
  timestamp: { type: Number },

  // source event fields
  blockHash: { type: String },
  blockNumber: { type: String },
  logIndex: { type: Number },
  transactionHash: { type: String },
});

withdrawnRewardSchema.index({ staker: 1 });
withdrawnRewardSchema.index({ transactionHash: 1, logIndex: 1 }, { unique: true });

module.exports = mongoose.model('WithdrawnReward', withdrawnRewardSchema);
