const mongoose = require('mongoose');

const stakeSchema = new mongoose.Schema({
  amount: { type: String },
  contractAddress: { type: String },
  staker: { type: String },

  // source event fields
  blockHash: { type: String },
  blockNumber: { type: String },
  logIndex: { type: Number },
  transactionHash: { type: String },
});

stakeSchema.index({ transactionHash: 1, logIndex: 1 }, { unique: true });

module.exports = mongoose.model('Stake', stakeSchema);
