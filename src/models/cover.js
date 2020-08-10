const mongoose = require('mongoose');

const coverSchema = new mongoose.Schema({
  address: { type: String },
  blockHash: { type: String },
  blockNumber: { type: Number },
  logIndex: { type: Number },
  transactionHash: { type: String },
  coverId: String,
  contractAddress: String,
  sumAssured: String,
  expiry: String,
  premium: String,
  premiumNXM: String,
  currency: String,
});

coverSchema.index({ transactionHash: 1, logIndex: 1 }, { unique: true });

module.exports = mongoose.model('CoverDetailsEvent', coverSchema);
