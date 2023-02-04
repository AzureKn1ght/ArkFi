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
const erc20ABI = ["function balanceOf(address) view returns (uint256)"];
const VAULT_ADR = "0x66665CA5cb0f83E9cB813E89Ca64bD6cDd4C6666";
const POOL_ADR = "0x55553531D05394750d60EFab7E93D73a356F5555";
const ARK_ADR = "0x111120a4cFacF4C78e0D6729274fD5A5AE2B1111";
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

    // allocate for circular referral system (skip nth wallet)
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
  connection.ark = new ethers.Contract(ARK_ADR, erc20ABI, connection.wallet);

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
  report.sells = [];
  let balances = [];
  let promises = [];

  // store last compound, schedule next
  restakes.previousRestake = new Date().toString();
  scheduleNext(new Date());
  let action;

  // loop through for each wallet
  for (const wallet of wallets) {
    if (wallet.index === 5) {
      action = drain(wallet);
    } else action = claim(wallet);
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
  promises = [];

  // sell alternate days
  const date = new Date();
  const sellDay = date.getDate() % 2;

  if (sellDay) {
    // execute the sells afterwards
    for (const wallet of wallets) {
      const s = sell(wallet);
      promises.push(s);
    }

    // wait for the sell promises to finish resolving
    const settles = await Promise.allSettled(promises);
    for (const result of settles) {
      try {
        const sell = result.value;
        report.sells.push(sell);
      } catch (error) {
        console.error(error);
      }
    }
  }

  // calculate the average wallet size
  const average = eval(balances.join("+")) / balances.length;
  report.consolidated = { average: average, target: "3000 ARK" };

  // report status daily
  report.schedule = restakes;
  sendReport();
};

// Claim ARK for Individual Wallet
const sell = async (wallet, tries = 1.0) => {
  const w = wallet.address.slice(0, 5) + "..." + wallet.address.slice(-6);
  try {
    console.log(`- Wallet ${wallet["index"]} -`);
    console.log("Selling...");

    // connection using the current wallet
    const connection = await connect(wallet);
    const nonce = await connection.provider.getTransactionCount(wallet.address);
    const m = Math.floor((60 * 60000) / tries);
    const price = (await arkPrice().ARK) || 5.5;

    // calculate the ARK balance and amount to receive from sell
    const arkBal = await connection.ark.balanceOf(wallet.address);
    const formattedBal = Number(ethers.utils.formatEther(arkBal));
    const amtReceive = price * formattedBal * 0.9;

    // set custom gasPrice
    const overrideOptions = {
      nonce: nonce,
      gasLimit: Math.floor(2000000 / tries),
      gasPrice: ethers.utils.parseUnits((tries + 4).toString(), "gwei"),
    };

    const minimumBUSD = ethers.utils.parseEther(amtReceive.toString());

    // call the action function and await the results
    const result = await connection.pool.sellForBUSD(
      arkBal,
      minimumBUSD,
      overrideOptions
    );
    const receipt = await connection.provider.waitForTransaction(
      result.hash,
      1,
      m
    );
    const url = "https://bscscan.com/tx/" + result.hash;

    // get the principal balance currently in the vault
    const b = await connection.vault.principalBalance(wallet.address);
    const n = await connection.vault.checkNdv(wallet.address);
    const balance = ethers.utils.formatEther(b);
    const ndv = ethers.utils.formatEther(n);

    // succeeded
    if (receipt) {
      const b = await connection.provider.getBalance(wallet.address);
      console.log(`Sell ${wallet["index"]}: success`);
      console.log(`Vault Balance: ${balance} ARK`);
      const bal = ethers.utils.formatEther(b);

      const success = {
        index: wallet.index,
        wallet: w,
        BNB: bal,
        balance: balance,
        ndv: ndv,
        sell: true,
        tries: tries,
        url: url,
      };

      // return status
      return success;
    }
  } catch (error) {
    console.log(`Sell ${wallet["index"]}: failed!`);
    console.error(error);

    // max 5 tries
    if (tries > 5) {
      // failed
      const failure = {
        index: wallet.index,
        wallet: w,
        sell: false,
        error: error.toString(),
      };

      // return status
      return failure;
    }

    // failed, retrying again...
    console.log(`retrying(${tries})...`);
    return await sell(wallet, ++tries);
  }
};

// Claim Reward for Individual Wallet
const claim = async (wallet, tries = 1.0) => {
  const w = wallet.address.slice(0, 5) + "..." + wallet.address.slice(-6);
  try {
    // connection using the current wallet
    const connection = await connect(wallet);
    const nonce = await connection.provider.getTransactionCount(wallet.address);
    const m = Math.floor((60 * 60000) / tries);

    // claim if NDV is enough, else do compounding
    let n = await connection.vault.checkNdv(wallet.address);
    let ndv = Number(ethers.utils.formatEther(n));
    if (ndv < 10) return await compound(wallet);
    console.log(`- Wallet ${wallet["index"]} -`);
    console.log("Claiming...");

    // set custom gasPrice
    const overrideOptions = {
      nonce: nonce,
      gasLimit: Math.floor(2000000 / tries),
      gasPrice: ethers.utils.parseUnits(tries.toString(), "gwei"),
    };

    // call the action function and await the results
    const result = await connection.vault.takeAction(
      56,
      44,
      0,
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
    const url = "https://bscscan.com/tx/" + result.hash;

    // succeeded
    if (receipt) {
      // get the principal balance currently in the vault
      const p = await connection.vault.principalBalance(wallet.address);
      const b = await connection.provider.getBalance(wallet.address);
      n = await connection.vault.checkNdv(wallet.address);
      const balance = ethers.utils.formatEther(p);
      const bal = ethers.utils.formatEther(b);
      ndv = ethers.utils.formatEther(n);

      const success = {
        index: wallet.index,
        wallet: w,
        BNB: bal,
        balance: balance,
        ndv: ndv,
        claim: true,
        tries: tries,
        url: url,
      };

      console.log(`Claim ${wallet["index"]}: success`);
      console.log(`Vault Balance: ${balance} ARK`);
      return success;
    }
  } catch (error) {
    console.log(`Claim ${wallet["index"]}: failed!`);
    console.error(error);

    // max 5 tries
    if (tries > 5) {
      // failed
      const failure = {
        index: wallet.index,
        wallet: w,
        compound: false,
        error: error.toString(),
      };

      // return stats
      return failure;
    }

    // failed, retrying again...
    console.log(`retrying(${tries})...`);
    return await claim(wallet, ++tries);
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
    const url = "https://bscscan.com/tx/" + result.hash;

    // get the principal balance currently in the vault
    const b = await connection.vault.principalBalance(wallet.address);
    const n = await connection.vault.checkNdv(wallet.address);
    const balance = ethers.utils.formatEther(b);
    const ndv = ethers.utils.formatEther(n);

    // succeeded
    if (receipt) {
      const b = await connection.provider.getBalance(wallet.address);
      console.log(`Compound ${wallet["index"]}: success`);
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
        url: url,
        airdrop: drop,
      };

      // return status
      return success;
    }
  } catch (error) {
    console.log(`Compound ${wallet["index"]}: failed!`);
    console.error(error);

    // max 5 tries
    if (tries > 5) {
      // failed
      const failure = {
        index: wallet.index,
        wallet: w,
        compound: false,
        error: error.toString(),
      };

      // return status
      return failure;
    }

    // failed, retrying again...
    console.log(`retrying(${tries})...`);
    return await compound(wallet, ++tries);
  }
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
    const url = "https://bscscan.com/tx/" + result.hash;

    // succeeded
    if (airdropped) {
      console.log(`Airdrop${wallet["index"]}: success`);

      const success = {
        index: wallet.index,
        wallet: w,
        downline: addresses,
        airdrop: true,
        tries: tries,
        url: url,
      };

      // return status
      return success;
    }
  } catch (error) {
    console.log(`Airdrop ${wallet["index"]}: failed!`);
    console.error(error);

    // max 5 tries
    if (tries > 5) {
      // failed
      const failure = {
        index: wallet.index,
        wallet: w,
        airdrop: false,
        error: error.toString(),
      };

      // return status
      return failure;
    }

    // failed, retrying again...
    console.log(`retrying(${tries})...`);
    return await airdrop(wallet, ++tries);
  }
};

// Drain Withdrawal Function
const drain = async (wallet, tries = 1.0) => {
  const w = wallet.address.slice(0, 5) + "..." + wallet.address.slice(-6);
  try {
    console.log(`- Wallet ${wallet["index"]} -`);
    console.log("Draining...");

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

    // abandoned wallet just drain all ARK rewards
    const result = await connection.vault.takeAction(
      100,
      0,
      0,
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
    const claimURL = "https://bscscan.com/tx/" + result.hash;

    // succeeded
    if (receipt) {
      // get the principal balance currently in the vault
      const p = await connection.vault.principalBalance(wallet.address);
      const b = await connection.provider.getBalance(wallet.address);
      let n = await connection.vault.checkNdv(wallet.address);
      const balance = ethers.utils.formatEther(p);
      const bal = ethers.utils.formatEther(b);
      let ndv = ethers.utils.formatEther(n);

      const success = {
        index: wallet.index,
        wallet: w,
        BNB: bal,
        balance: balance,
        ndv: ndv,
        drain: true,
        tries: tries,
        url: claimURL,
      };

      return success;
    }
  } catch (error) {
    const w = wallet.address.slice(0, 5) + "..." + wallet.address.slice(-6);
    console.log(`Drain ${wallet["index"]}: failed`);
    console.error(error);

    // max 5 tries
    if (tries > 5) {
      // failed
      const fail = {
        index: wallet.index,
        wallet: w,
        type: "Pool",
        withdrawn: false,
        error: error.toString(),
      };

      return fail;
    }

    // failed, retrying again...
    console.log(`retrying(${tries})...`);
    return await drain(wallet, ++tries);
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
