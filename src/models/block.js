const mongoose = require('mongoose');

const blockSchema = new mongoose.Schema({
  hash: { type: String },
  number: { type: Number },
  timestamp: { type: Number },
});

blockSchema.index({ number: 1 }, { unique: true });
blockSchema.index({ hash: 1 }, { unique: true });

module.exports = mongoose.model('Block', blockSchema);
