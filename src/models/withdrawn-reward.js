const mongoose = require('mongoose');

const withdrawnRewardSchema = new mongoose.Schema({
  staker: { type: String },
  amount: { type: String },
  timestamp: { type: Number },
  blockNumber: { type: Number },
});

withdrawnRewardSchema.index({ staker: 1 });

module.exports = mongoose.model('WithdrawnReward', withdrawnRewardSchema);
