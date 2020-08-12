const mongoose = require('mongoose');

const coverSchema = new mongoose.Schema({
  coverId: String,
  contractAddress: String,
  sumAssured: String,
  expiry: String,
  premium: String,
  premiumNXM: String,
  currency: String,

  // source event fields
  blockHash: { type: String },
  blockNumber: { type: String },
  logIndex: { type: Number },
  transactionHash: { type: String },
});

coverSchema.index({ transactionHash: 1, logIndex: 1 }, { unique: true });

module.exports = mongoose.model('Cover', coverSchema);
