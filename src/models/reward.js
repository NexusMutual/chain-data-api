const mongoose = require('mongoose');

const rewardSchema = new mongoose.Schema({
  address: { type: String },
  blockHash: { type: String },
  blockNumber: { type: Number },
  logIndex: { type: Number },
  transactionHash: { type: String },

  timestamp: { type: Number },
  amount: { type: String },
  contractAddress: { type: String },
});

rewardSchema.index({ transactionHash: 1, logIndex: 1 }, { unique: true });

module.exports = mongoose.model('Reward', rewardSchema);
