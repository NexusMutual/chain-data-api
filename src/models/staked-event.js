const mongoose = require('mongoose');

const stakedEventSchema = new mongoose.Schema({
  address: { type: String },
  blockHash: { type: String },
  blockNumber: { type: String },
  logIndex: { type: Number },
  transactionHash: { type: String },

  amount: { type: String },
  contractAddress: { type: String },
  staker: { type: String },
})

stakedEventSchema.index({ transactionHash: 1, logIndex: 1 }, { unique: true });

module.exports = mongoose.model('StakedEvent', stakedEventSchema);
