const fetch = require('node-fetch');
const Web3 = require('web3');
const log = require('./log');

const { setupLoader } = require('@openzeppelin/contract-loader');

class VersionData {

  constructor (chain, versionDataURL, providerURL) {
    this.chain = chain;
    this.versionDataURL = versionDataURL;
    this.providerURL = providerURL;
  }

  async init () {
    log.info(`Fetching version data from ${this.versionDataURL} for chain ${this.chain}`);
    const data = await fetch(this.versionDataURL).then(res => res.json());

    if (typeof data[this.chain] === 'undefined') {
      throw new Error(`No data for ${this.chain} chain found.`);
    }

    this.data = data[this.chain].abis
      .reduce((data, abi) => ({ ...data, [abi.code]: { ...abi, contractAbi: JSON.parse(abi.contractAbi) } }), {});
    const web3 = new Web3(this.providerURL);
    this.web3 = web3;

    this.loader = setupLoader({
      provider: web3.eth.currentProvider,
    }).truffle;
  }

  address (code) {
    return this.data[code].address;
  }

  instance (code) {
    const abi = this.data[code].contractAbi;
    const address = this.address(code);
    return this.loader.fromABI(abi, null, address);
  }

  getABIList () {
    const abiList = [];
    for (const abi of Object.values(this.data)) {
      abiList.push(abi);
    }
    return abiList;
  }
}

module.exports = VersionData;
