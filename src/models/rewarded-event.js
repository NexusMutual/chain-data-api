const mongoose = require('mongoose');

const rewardedEventSchema = new mongoose.Schema({
  address: { type: String },
  blockHash: { type: String },
  blockNumber: { type: String },
  logIndex: { type: Number },
  transactionHash: { type: String },

  timestamp: { type: Number },
  amount: { type: String },
  contractAddress: { type: String },
});

rewardedEventSchema.index({ transactionHash: 1, logIndex: 1 }, { unique: true });

module.exports = mongoose.model('RewardedEvent', rewardedEventSchema);
