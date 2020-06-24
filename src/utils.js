const hex = string => '0x' + Buffer.from(string).toString('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));


function chunk(arr, chunkSize) {
  let chunks = [];
  let i = 0;
  let n = arr.length;

  while (i < n) {
    chunks.push(arr.slice(i, i + chunkSize));
    i += chunkSize;
  }
  return chunks;
}

module.exports = {
  hex,
  sleep,
  chunk
}
