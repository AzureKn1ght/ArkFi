# Ark Compound
![ArkFi](https://www.arkfi.io/img/og_image.png)


## Strategy 
Simple Bot to Restake tokens every 24h on ArkFi. Creating compound interest with ARK tokens. 

This strategy involves triggering the compound function on the ArkFi vault contract every 24 hours in order to continue receiving the maximum payout rewards from the ROI dapp. A notification email report is then sent via email to update the status of the wallets. This compound bot supports multiple wallets and just loops through all of them. Just change the *initWallets* code to the number you like!  

URL: https://app.arkfi.io/swap?ref=0xab951ec23283ee00ae0a575b89ddf40df28e23ab \
Donate: 0xaB951EC23283eE00AE0A575B89dDF40Df28e23Ab

# ENV Variables 
You will need to create a file called *.env* in the root directory, copy the text in *.env.example* and fill in the variables 


# How to Run 
You could run it on your desktop just using [Node.js](https://github.com/nodejs/node) in your terminal. However, on a production environment, it is recommended to use something like [PM2](https://github.com/Unitech/pm2) to run the processes to ensure robust uptime and management. 

### ARK Compound
```
pm2 start drain.js -n "ARK"
pm2 save

```
