import { ethers } from 'ethers'
import { program } from 'commander'
import { randomBytes } from 'node:crypto'

function addHeader(opt, headers) {
  const a = opt.split(':', 2)
  headers.set(a[0], a[1])
  return headers
}

program
  .option('-r, --rpc <url>', 'RPC endpoint URL', 'http://localhost:8545')
  .option('--header <k>:<v>', 'add a header to fetch requests, may be repeated', addHeader, new Map())
  .option('-z, --size <kB>', 'calldata kilobytes to include per transaction', '64')
  .option('--trim-bytes <b>', 'trim a few bytes from the size', '256')
  .option('-s, --slots <n>', 'number of slots to run for', '10')
  .option('-d, --delay <secs>', 'number of seconds after slot boundary to submit transactions', '3')
  .option('-t, --txns <n>', 'average number of transactions to aim to submit per slot', '2')
  .option('-m, --max-txns <n>', 'maximum transactions to submit per slot', '8')
  .option('-c, --contract <addr>', 'transaction recipient', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
  .option('-f, --fee-mult <n>', 'base fee multiplier', '2')
  .option('-g, --gas-mult <n>', 'gas limit multiplier', '2')
  .option('-p, --priority-fee <gwei>', 'max priority fee per gas', '10')
  .requiredOption('-k, --signer <key>', 'private key of account to send transactions from')
program.parse()
const options = program.opts()

const fetchRequest = new ethers.FetchRequest(options.rpc)
options.header.forEach((v, k) => fetchRequest.setHeader(k, v))
const provider = new ethers.JsonRpcProvider(fetchRequest)
console.log('Awaiting network...')
const network = await provider.getNetwork()
console.log(`Got ${network.name}`)
const signer = new ethers.Wallet(options.signer, provider)
console.log(`Signer: ${await signer.getAddress()}`)
console.log(`Balance: ${ethers.formatEther(await provider.getBalance(signer))} ether`)
console.log(`Nonce: ${await provider.getTransactionCount(signer)}`)

let slotsLeft = parseInt(options.slots)
const total = parseInt(options.txns) * slotsLeft
const delay = parseInt(options.delay)
const maxTxns = parseInt(options.maxTxns)
const sizeBytes = parseInt(options.size) * 1024 - parseInt(options.trimBytes)
const feeMult = BigInt(options.feeMult)
const gasMult = BigInt(options.gasMult)
const prioFee = ethers.parseUnits(options.priorityFee, 'gwei')

function makeTxn(maxFee, nonce) {
  const tx = new ethers.Transaction()
  tx.chainId = network.chainId
  tx.maxFeePerGas = maxFee
  tx.maxPriorityFeePerGas = prioFee
  tx.nonce = nonce
  tx.to = options.contract
  tx.data = `0x${randomBytes(sizeBytes).toString('hex')}`
  return tx
}

const shortHash = (hash) => `${hash.substring(0, 4)}..${hash.substring(hash.length - 4)}`
const nonces = new Map()

const submitted = []
let landed = 0

let checkWaiting
let slotWaiting
let slot

async function processSubmitted() {
  while (submitted.length && Promise.race([submitted[0], false])) {
    const receipt = await submitted.shift()
    console.log(`${nonces.get(receipt.hash)} (${shortHash(receipt.hash)}) included in ${receipt.blockNumber}`)
    landed += 1
  }
  checkWaiting = false
}

async function processSlot() {
  if (!slotsLeft) return
  const blockNumber = await provider.getBlockNumber()
  console.log(`At slot ${slot} (block: ${blockNumber})`)
  const block = await provider.getBlock(blockNumber)
  const baseFee = block.baseFeePerGas
  const fastFee = baseFee * feeMult
  console.log(`Base fee: ${ethers.formatUnits(baseFee, 'gwei')} gwei; Fast fee: ${ethers.formatUnits(fastFee, 'gwei')} gwei`)
  const startingNonce = await signer.getNonce()
  const toSubmit = Math.min(maxTxns, Math.trunc((total - landed) / slotsLeft))
  let gasLimit = null
  for (const i of Array(toSubmit).keys()) {
    const tx = makeTxn(fastFee, startingNonce + i)
    if (!gasLimit) {
      tx.gasLimit = block.gasLimit
      gasLimit = gasMult * await signer.estimateGas(tx)
    }
    tx.gasLimit = gasLimit
    const popTx = await signer.populateTransaction(tx)
    const signedTx = await signer.signTransaction(popTx)
    const response = await provider.broadcastTransaction(signedTx)
    console.log(`Submitted ${response.nonce} as ${shortHash(response.hash)}`)
    nonces.set(response.hash, response.nonce)
    submitted.push(response.wait())
  }
  slotsLeft -= 1
  slotWaiting = false
}

function everySecond() {
  const mod = Math.trunc(Date.now() / 1000) % 12
  checkWaiting = true
  if (mod === 11) slot += 1
  if ((mod + 1) % 12 === delay)
    slotWaiting = true
}

const GENESIS = 1606824023

let intervalId

const onSecondBoundary = () => {
  const now = Math.trunc(Date.now() / 1000)
  const mod = now % 12
  slot = (now - mod - 1 - GENESIS) / 12
  intervalId = setInterval(everySecond, 1000)
}

setTimeout(onSecondBoundary, Date.now() % 1000)

while (submitted.length || slotsLeft) {
  if (slotWaiting) await processSlot()
  else if (checkWaiting) await processSubmitted()
  else await new Promise(resolve => setTimeout(resolve, 500))
}

clearInterval(intervalId)
