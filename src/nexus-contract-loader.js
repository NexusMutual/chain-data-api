const fetch = require('node-fetch');
const log = require('./log');

const { setupLoader } = require('@openzeppelin/contract-loader');

const CHAIN = {
  1: 'mainnet',
  3: 'ropsten',
  4: 'rinkeby',
  42: 'kovan',
}

class NexusContractLoader {

  constructor (chainId, versionDataURL, web3) {
    const chain = CHAIN[chainId];
    if (!chain) {
      throw new Error(`Unknown chainId: ${chainId}`);
    }
    this.chain = chain;
    this.versionDataURL = versionDataURL;
    this.web3 = web3;
    this.provider = web3.eth.currentProvider;
  }

  async init () {
    log.info(`Fetching version data from ${this.versionDataURL} for chain ${this.chain}`);
    const data = await fetch(this.versionDataURL).then(res => res.json());

    if (typeof data[this.chain] === 'undefined') {
      throw new Error(`No data for ${this.chain} chain found.`);
    }

    this.data = data[this.chain].abis
      .reduce((data, abi) => ({ ...data, [abi.code]: { ...abi, contractAbi: JSON.parse(abi.contractAbi) } }), {});

    this.loader = setupLoader({
      provider: this.provider,
      defaultGas: 6e6, // 1 million
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

  web3Instance (code) {
    const abi = this.data[code].contractAbi;
    const address = this.address(code);
    return new this.web3.eth.Contract(abi, address);
  }
}

module.exports = NexusContractLoader;
