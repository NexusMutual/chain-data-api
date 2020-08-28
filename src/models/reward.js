const mongoose = require('mongoose');

const rewardSchema = new mongoose.Schema({
  timestamp: { type: Number },
  amount: { type: String },
  contractAddress: { type: String },
  contractStake: { type: String },

  // source event fields
  blockHash: { type: String },
  blockNumber: { type: String },
  logIndex: { type: Number },
  transactionHash: { type: String },
});

rewardSchema.index({ transactionHash: 1, logIndex: 1 }, { unique: true });

module.exports = mongoose.model('Reward', rewardSchema);
