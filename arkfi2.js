/*
- ArkFi Compound - 
This strategy involves triggering the compound function on the ArkFi vault contract every 24 hours in order to continue receiving the maximum payout rewards from the ROI dapp. A notification email report is then sent via email to update the status of the wallets. This compound bot supports multiple wallets and just loops through all of them. Just change the 'initWallets' code to the number you like!  

URL: https://app.arkfi.io/swap?ref=0xbaee15e7905874ea5e592efee19b2d0082d538b8
*/

// Import required node modules
const scheduler = require("node-schedule");
const nodemailer = require("nodemailer");
const { ethers } = require("ethers");
const figlet = require("figlet");
require("dotenv").config();
const fs = require("fs");

// ABIs for the vault and pool contracts
const VAULT_ABI = require("./vaultABI");
const POOL_ABI = require("./poolABI");

// Import the environment variables and contract addresses
const VAULT_ADR = "0x66665CA5cb0f83E9cB813E89Ca64bD6cDd4C6666";
const POOL_ADR = "0x55553531D05394750d60EFab7E93D73a356F5555";
const RPC_URL = process.env.BSC_RPC;

// Storage obj
var restakes = {
  previousRestake: "",
  nextRestake: "",
};
var report = {};

// Main Function
const main = async () => {
  let restakeExists = false;
  try {
    // check if restake file exists
    if (!fs.existsSync("./restakes.json")) await storedData();

    // get stored values from file
    const storedData = JSON.parse(fs.readFileSync("./restakes.json"));

    // not first launch, check data
    if ("nextRestake" in storedData) {
      const nextRestake = new Date(storedData.nextRestake);

      // restore claims schedule
      if (nextRestake > new Date()) {
        console.log("Restored Restake: " + nextRestake);
        scheduler.scheduleJob(nextRestake, ARKCompound);
        restakeExists = true;
      }
    }
  } catch (error) {
    console.error(error);
  }

  // first time, no previous launch
  if (!restakeExists) ARKCompound();
};

// Import wallet detail
const initWallets = (n) => {
  let wallets = [];
  for (let i = 1; i <= n; i++) {
    let wallet = {
      address: process.env["ADR_" + i],
      key: process.env["PVK_" + i],
      index: i,
      referer: "",
      downline: "",
    };

    // allocate for a circular referral system (skip nth wallet)
    if (i === 1) wallet.referer = process.env["ADR_" + (n - 1)];
    else wallet.referer = process.env["ADR_" + (i - 1)];
    if (i >= n - 1) wallet.downline = process.env["ADR_" + 1];
    else wallet.downline = process.env["ADR_" + (i + 1)];

    wallets.push(wallet);
  }
  return wallets;
};

// Ethers connect on each wallet
const connect = async (wallet) => {
  let connection = {};

  // Add connection properties
  connection.provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  connection.wallet = new ethers.Wallet(wallet.key, connection.provider);
  connection.pool = new ethers.Contract(POOL_ADR, POOL_ABI, connection.wallet);
  connection.vault = new ethers.Contract(
    VAULT_ADR,
    VAULT_ABI,
    connection.wallet
  );

  // connection established
  await connection.provider.getTransactionCount(wallet.address);
  return connection;
};

// ARK Compound Function
const ARKCompound = async () => {
  // start function
  console.log("\n");
  console.log(
    figlet.textSync("ArkCompound", {
      font: "Standard",
      horizontalLayout: "default",
      verticalLayout: "default",
      width: 80,
      whitespaceBreak: true,
    })
  );

  // get wallet detail from .env
  const wallets = initWallets(5);

  // storage array for sending reports
  report.title = "ArkFi Report " + todayDate();
  report.actions = [];
  report.bonds = [];
  let balances = [];
  let promises = [];

  // store last compound, schedule next
  restakes.previousRestake = new Date().toString();
  scheduleNext(new Date());

  // loop through for each wallet
  for (const wallet of wallets) {
    const action = compound(wallet);
    promises.push(action);
  }

  // wait for all the promises to finish resolving
  const results = await Promise.allSettled(promises);
  for (const result of results) {
    try {
      const action = result.value;
      report.actions.push(action);
      if (action.balance) {
        balances.push(parseFloat(action.balance));
      }
    } catch (error) {
      console.error(error);
    }
  }

  // calculate the average wallet size
  const average = eval(balances.join("+")) / balances.length;
  report.consolidated = { average: average, target: "300 ARK" };

  // report status daily
  report.schedule = restakes;
  sendReport();
};

// Airdrop Individual Wallet
const airdrop = async (wallet, tries = 1.0) => {
  const w = wallet.address.slice(0, 5) + "..." + wallet.address.slice(-6);
  try {
    console.log(`- Wallet ${wallet["index"]} -`);
    console.log("Airdroping...");

    // connection using the current wallet
    const connection = await connect(wallet);
    const nonce = await connection.provider.getTransactionCount(wallet.address);
    const m = Math.floor((60 * 60000) / tries);

    // set custom gasPrice
    const overrideOptions = {
      nonce: nonce,
      gasLimit: Math.floor(2000000 / tries),
      gasPrice: ethers.utils.parseUnits(tries.toString(), "gwei"),
    };

    // get the airdrop balance and the downline to send it to
    const val = await connection.vault.airdropBalance(wallet.address);
    console.log("Airdroping: " + val.toString());
    const addresses = [wallet.downline];
    const amounts = [val];

    // call airdrop function and await the results
    const result = await connection.vault.airdrop(
      addresses,
      amounts,
      overrideOptions
    );
    const airdropped = await connection.provider.waitForTransaction(
      result.hash,
      1,
      m
    );

    // succeeded
    if (airdropped) {
      const v = await connection.vault.airdropBalance(wallet.address);
      console.log(`Airdrop${wallet["index"]}: success`);
      const airdropBal = ethers.utils.formatEther(v);

      const success = {
        index: wallet.index,
        wallet: w,
        downline: addresses,
        airdropBal: airdropBal,
        airdrop: true,
        tries: tries,
      };

      // return status
      return success;
    }
  } catch (error) {
    console.log(`Wallet${wallet["index"]}: failed!`);
    console.error(error);

    // max 5 tries
    if (tries > 5) {
      // failed
      const failure = {
        index: wallet.index,
        wallet: w,
        airdrop: false,
        error: error,
      };

      // return status
      return failure;
    }

    // failed, retrying again...
    console.log(`retrying(${tries})...`);
    return await airdrop(wallet, ++tries);
  }
};

// Compound Individual Wallet
const compound = async (wallet, tries = 1.0) => {
  const w = wallet.address.slice(0, 5) + "..." + wallet.address.slice(-6);
  try {
    console.log(`- Wallet ${wallet["index"]} -`);
    console.log("Compounding...");

    // connection using the current wallet
    const connection = await connect(wallet);
    const nonce = await connection.provider.getTransactionCount(wallet.address);
    const m = Math.floor((60 * 60000) / tries);

    // set custom gasPrice
    const overrideOptions = {
      nonce: nonce,
      gasLimit: Math.floor(2000000 / tries),
      gasPrice: ethers.utils.parseUnits(tries.toString(), "gwei"),
    };

    // call the action function and await the results
    const result = await connection.vault.takeAction(
      0,
      50,
      50,
      false,
      false,
      false,
      overrideOptions
    );
    const receipt = await connection.provider.waitForTransaction(
      result.hash,
      1,
      m
    );

    // get the principal balance currently in the vault
    const b = await connection.vault.principalBalance(wallet.address);
    const n = await connection.vault.checkNdv(wallet.address);
    const balance = ethers.utils.formatEther(b);
    const ndv = ethers.utils.formatEther(n);

    // succeeded
    if (receipt) {
      const b = await connection.provider.getBalance(wallet.address);
      console.log(`Wallet${wallet["index"]}: success`);
      console.log(`Vault Balance: ${balance} ARK`);
      const bal = ethers.utils.formatEther(b);
      const drop = await airdrop(wallet);

      const success = {
        index: wallet.index,
        wallet: w,
        BNB: bal,
        balance: balance,
        ndv: ndv,
        compound: true,
        tries: tries,
        airdrop: drop,
      };

      // return status
      return success;
    }
  } catch (error) {
    console.log(`Wallet${wallet["index"]}: failed!`);
    console.error(error);

    // max 5 tries
    if (tries > 5) {
      // failed
      const failure = {
        index: wallet.index,
        wallet: w,
        compound: false,
        error: error,
      };

      // return status
      return failure;
    }

    // failed, retrying again...
    console.log(`retrying(${tries})...`);
    return await compound(wallet, ++tries);
  }
};

// Job Scheduler Function
const scheduleNext = async (nextDate) => {
  // set next job to be 24hrs from now
  nextDate.setHours(nextDate.getHours() + 24);
  restakes.nextRestake = nextDate.toString();
  console.log("Next Restake: ", nextDate);

  // schedule next restake
  scheduler.scheduleJob(nextDate, ARKCompound);
  storeData();
  return;
};

// Data Storage Function
const storeData = async () => {
  const data = JSON.stringify(restakes);
  fs.writeFile("./restakes.json", data, (err) => {
    if (err) {
      console.error(err);
    } else {
      console.log("Data stored:", restakes);
    }
  });
};

// Get Ark Price Function
const arkPrice = async () => {
  try {
    // just initialize connection
    const wallets = initWallets(1);
    const connection = await connect(wallets[0]);

    // get the price of Ark from pool
    const rawPrice = await connection.pool.getCurrentPriceInUSD();
    let price = ethers.utils.formatEther(rawPrice);
    price = Number(price).toFixed(2);

    return { ARK: price };
  } catch (error) {
    console.error(error);
    return null;
  }
};

// Current Date function
const todayDate = () => {
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, "0");
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const yyyy = today.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};

// Send Report Function
const sendReport = async () => {
  try {
    // get the formatted date
    const today = todayDate();
    report.title = "ArkFi Report " + today;

    // get price of Furio
    const price = await arkPrice();
    report.price = price;

    // configure email server
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_ADDR,
        pass: process.env.EMAIL_PW,
      },
    });

    // setup mail params
    const mailOptions = {
      from: process.env.EMAIL_ADDR,
      to: process.env.RECIPIENT,
      subject: "ArkFi Report: " + today,
      text: JSON.stringify(report, null, 2),
    };

    // send the email message
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.log(error);
      } else {
        console.log("Email sent: " + info.response);
      }
    });

    // clear var
    report = {};
  } catch (error) {
    console.error(error);
  }
};

main();
