const mongoose = require('mongoose');

const coverDetailsEventSchema = new mongoose.Schema({
  address: { type: String },
  blockHash: { type: String },
  blockNumber: { type: String },
  logIndex: { type: Number },
  transactionHash: { type: String },

  cid: String,
  scAdd: String,
  sumAssured: String,
  expiry: String,
  premium: String,
  premiumNXM: String,
  curr: String
})

coverDetailsEventSchema.index({ transactionHash: 1, logIndex: 1 }, { unique: true });

module.exports = mongoose.model('CoverDetailsEvent', coverDetailsEventSchema);
