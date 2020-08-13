const mongoose = require('mongoose');

const stakerSnapshot = new mongoose.Schema({
  address: { type: String },
  deposit: { type: String },
  reward: { type: String },
  timestamp: { type: Number },
  createdAt: { type: Date },
  blockNumber: { type: Number },
});

stakerSnapshot.index({ address: 1, timestamp: 1 }, { unique: true });

module.exports = mongoose.model('StakerSnapshot', stakerSnapshot);
