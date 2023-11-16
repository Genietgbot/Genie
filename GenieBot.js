require('dotenv').config();
const { ethers, Wallet, utils } = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const token = process.env.BOT_TOKEN;
const redis = require('redis');
const axios = require('axios');
const bluebird = require('bluebird');
const bot = new TelegramBot(token, { polling: true });
const redisUrl = process.env.REDIS_URL;
const provider = new ethers.providers.JsonRpcProvider(process.env.GOERLI_PROVIDER_URL);
process.env.NTBA_FIX_350 = true;
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

const client = redis.createClient({
    url: redisUrl,
    retry_strategy: function(options) {
        if (options.error && options.error.code === 'ECONNREFUSED') {
            return new Error('The server refused the connection');
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
            return new Error('Retry time exhausted');
        }
        if (options.attempt > 10) {
            return undefined;
        }
        return Math.min(options.attempt * 100, 3000);
    }
});

bluebird.promisifyAll(client);

client.on('connect', () => {
    console.log('[PASS]'.green + ' Redis Connected');
});
client.on('error', (err) => {
    console.error('Redis error:', err);
});

const getAsync = bluebird.promisify(client.get).bind(client);
const setAsync = bluebird.promisify(client.set).bind(client);
const keysAsync = bluebird.promisify(client.keys).bind(client);
const TELEGRAM_BASE_URL = `https://api.telegram.org/bot${token}/`;
const callbackThrottle = {};
let interactions = {};
let lastMessageId1 = null;
let lastMessageId2 = null;
let storedSymbol = [];

bot.onText(/\/start/i, async (msg) => {
    if (msg.chat.type === 'private') {
        const username = msg.from.username;
        console.log(username);
        const chatId = msg.chat.id;
        const imagePath = 'src/genie prof pic.png';

        let walletAddress = await getAsync(`wallets:${username}`);
        if (!username) {
            console.error("Username is not defined.");
            bot.sendMessage(msg.chat.id, `❌ You haven't set up a Telegram Username.`);
            return;
        }

        if (walletAddress) {
            const walletInfo = JSON.parse(walletAddress);
            walletAddress = walletInfo.address;
        }
        setAsync(`chatID:${username}`, chatId);
        const safeUsername = username.replace(/_/g, '\\_');

        let response = `🧞‍♂️ Welcome to the Genie Wish Granter Bot, @${safeUsername}! 🧞‍♂️\n\n`;

        if (walletAddress) {
            const shortWalletAddress = shortenWalletAddress(walletAddress);
            response += `🔑 *Wallet Address:* ${shortWalletAddress}\n\n`;
        } else {
            response += "❗️ *Warning:* Your wallet is not set up yet. Please set it up for seamless transactions.\n\n";
        }


        const userID = `${chatId}_${Date.now()}`;

        interactions[userID] = {
            username: username
        };

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🌟 Create Wallet', callback_data: `create_${userID}` },
                    { text: '📥 Import Wallet', callback_data: `import_${userID}` }
                ],
                [
                    { text: '💼 Wallet Information', callback_data: `info_${userID}` },
                    { text: '⚙️ Settings', callback_data: `settings_${userID}` }
                ],
                [
                    { text: '📉 Sell', callback_data: `asell_${userID}` },
                ],
            ]
        };

        bot.sendPhoto(chatId, imagePath, { caption: response, parse_mode: 'Markdown', reply_markup: keyboard, fileOptions: { contentType: 'png' } })
            .catch((err) => {
                console.error("Error sending photo:", err);
            });
    }
});

bot.onText(/^\/setGenie (0x[0-9a-fA-F]{40})$/i, async (msg, match) => {
    if (msg.chat.type !== 'private') {
    const chatId = msg.chat.id;
    const contractAddress = match[1];
    console.log("triggered");
    const user = await bot.getChatMember(chatId, msg.from.id);
    if (user.status === 'administrator' || user.status === 'creator') {
        await setAsync(`channel:${chatId}`, contractAddress);
        bot.sendMessage(chatId, `Contract address set to: ${contractAddress}`);
    } else {
        bot.sendMessage(chatId, 'Only channel admins can set the contract address.');
        return;
    }

    console.log("entered setgenie");
    const validAddressRegex = /^(0x)?[0-9a-fA-F]{40}$/;

    if (!validAddressRegex.test(contractAddress)) {
        bot.sendMessage(chatId, 'Invalid Ethereum contract address.');
        return;
    }
}
});

bot.onText(/^\/genie (\d+(\.\d+)?)$/i, async (msg, match) => {

    if (msg.chat.type !== 'private') {
        
        const chatId = msg.chat.id;
        const username = msg.from.username;
        const safeUsername = username.replace(/_/g, '\\_');
        console.log('Raw input:', match[1]);
        const amountToBuy = parseFloat(match[1]);
        console.log('Parsed amountToBuy:', amountToBuy);
        if (isNaN(amountToBuy) || amountToBuy <= 0) {
            bot.sendMessage(chatId, "Invalid Buy amount.");
            return;
        }
        console.log(chatId, username, amountToBuy);
        const contractAddress = await getAsync(`channel:${chatId}`);
        let gasBuffer = await getAsync(`settings:gas_buffer:${username}`);
        const slippage = await getAsync(`settings:slippage:${username}`);
        const walletInfo = await getAsync(`wallets:${username}`);
        const userChatId = await getAsync(`chatID:${username}`);
        const missingInfo = [];

        if (!contractAddress) {
            missingInfo.push('contract address');
        }

        if (!gasBuffer) {
            missingInfo.push('gas buffer setting');
        }

        if (!slippage) {
            missingInfo.push('slippage setting');
        }

        if (!walletInfo) {
            missingInfo.push('wallet information');
        }

        const balanceWei = await provider.getBalance(JSON.parse(walletInfo).address);
        const balanceEther = ethers.utils.formatEther(balanceWei);

        if (missingInfo.length > 0) {
            const missingInfoMessage = `@${safeUsername}, the following issue: ${missingInfo.join(', ')}. Please make sure to provide the necessary details.`;
            await bot.sendMessage(chatId, missingInfoMessage);
        } else {
            try {
                const privateKey = JSON.parse(walletInfo).privateKey;
                const wallet = new ethers.Wallet(privateKey, provider);

                const uniswapRouterAddress = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
                const uniswapRouterAbi = ['function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable returns (uint256[] memory amounts)', 'function getAmountsOut(uint amountIn, address[] memory path) internal view returns (uint[] memory amounts)', 'function getAmountsIn(address factory, uint amountOut, address[] memory path) internal view returns (uint[] memory amounts)'];
                const uniswapRouter = new ethers.Contract(uniswapRouterAddress, uniswapRouterAbi, wallet);

                const tokenToBuyAddress = contractAddress;
                const mainWethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
                const goerliWethAddress = '0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6';
                const path = [goerliWethAddress, tokenToBuyAddress];
                const slippagePercentage = parseFloat(JSON.parse(slippage).slippage);

                gasBuffer = JSON.parse(gasBuffer).gasBuffer;
                console.log("gasbuffer: ", gasBuffer);
                console.log('Amount to Buy:', amountToBuy);
                console.log('Slippage Percentage:', slippagePercentage);

                const amountIn = ethers.utils.parseEther(amountToBuy.toString());
                const amountOut = await uniswapRouter.getAmountsOut(amountIn, path); 
                const amountOutMinWithSlippage = Math.round(amountOut[1] * (1 - slippagePercentage / 100) / 1e9);
                console.log(`amountOut: ${amountOut}`);
                console.log(`amountOutMinWithSlippage: ${amountOutMinWithSlippage}`);

                const gasPrice = await provider.getGasPrice();
                console.log('Current Gas Price:', gasPrice.toString());
                console.log(balanceEther);
                console.log(amountToBuy);

                if(balanceEther<=amountToBuy){
                    bot.sendMessage(chatId, `@${safeUsername} Funds too low!`, { parse_mode: 'Markdown' });
                    return;
                }

                const estimatedGas = await uniswapRouter.estimateGas.swapExactETHForTokensSupportingFeeOnTransferTokens(
                    0,
                    path,
                    wallet.address,
                    Date.now() + 1000 * 60 * 10,
                    { value: ethers.utils.parseEther(amountToBuy.toString()) }
                );

                const increasedGasPrice = Math.ceil(gasPrice * (1 + gasBuffer / 100) * (ethers.BigNumber.from(1e9)));
                console.log(increasedGasPrice);
                console.log('Estimated Gas:', estimatedGas.toString());

                const gasLimit = Math.ceil(estimatedGas.toNumber() * (1 + gasBuffer / 100));
                console.log('Calculated Gas Limit:', gasLimit);

                if (gasLimit <= 0) {
                    console.error('Invalid Gas Limit:', gasLimit);
                    throw new Error('Invalid Gas Limit');
                }

                const gasPriceInGwei = ethers.BigNumber.from(increasedGasPrice);

                const gasLimitBN = ethers.BigNumber.from(gasLimit);

                const gasCost = gasPriceInGwei.mul(gasLimitBN);
                console.log('Gas Cost:', gasCost.toString());

                const amountToBuyInWei = ethers.utils.parseEther(amountToBuy.toString());
                const totalMaxCost = gasCost.add(amountToBuyInWei);
                const totalMaxCostInEth = ethers.utils.formatEther(totalMaxCost);
                console.log('Total Max Cost:', totalMaxCostInEth);

                if(balanceEther<=totalMaxCostInEth){
                    bot.sendMessage(chatId, `@${safeUsername} Funds too low!`, { parse_mode: 'Markdown' });
                }

                await bot.sendMessage(userChatId, 'Your transaction was initiated!');
                const transaction = await uniswapRouter.swapExactETHForTokensSupportingFeeOnTransferTokens(
                    amountOutMinWithSlippage.toString(),
                    path,
                    wallet.address,
                    Date.now() + 1000 * 60 * 10,
                    { gasLimit, gasPrice: increasedGasPrice.toString(), value: ethers.utils.parseEther(amountToBuy.toString()) }
                );

                const transactionLink = `https://goerli.etherscan.io/tx/${transaction.hash}`;
                const message = `Your transaction link: [View on Etherscan](${transactionLink})`;

                await bot.sendMessage(userChatId, message, { parse_mode: 'Markdown' });
                await transaction.wait();
                await bot.sendMessage(userChatId, 'Your transaction was successful!');
                await bot.sendMessage(chatId, `@${safeUsername} Wish Granted!`, { parse_mode: 'Markdown' });

                const channelCA = await getAsync(`channel:${chatId}`);
                const tokenContract = new ethers.Contract(
                    channelCA,
                        [
                          'function symbol() view returns (string)',
                          'function name() public pure returns (string memory)',
                          'function totalSupply() external view returns (uint256)',
                        ],
                        provider
                      );
                    
                        const tokenSymbol = await tokenContract.symbol();
                        const tokenName = await tokenContract.name();
                        const totalSupply = await tokenContract.totalSupply() / 1e9;
                        const amountInUSD = amountIn * await fetchEthToUsdExchangeRate() ;
                        const pricePerToken = amountInUSD / amountOut[1] / 1e9 ;
                        const marketCap = pricePerToken * totalSupply / 1e9;
                        console.log("Market Cap: ", marketCap.toString());
                        console.log("Total Supply: ", totalSupply.toString());
                        console.log("Current Price: ", pricePerToken.toString());
                        console.log("amountInUSD: ", amountInUSD);
                        console.log("fetchEthToUsdExchangeRate: ", await fetchEthToUsdExchangeRate());
                       
                        
                const emojis = generateBuyEmojis(amountIn, marketCap);
                let response = '';

                response += `@${safeUsername} Wish Granted!\n`;
                response += '🧞‍♂️ ${tokenName} | ${tokenSymbol} 🧞‍♂️\n\n';
                response += ` ${emojis}\n\n`;
                response += `🪄 *Master:* @${safeUsername}__\n`;
                response += `📊 *Market Cap:* __${marketCap}x__\n`;
                response += `💸 *ETH:* __${amountIn} ETH__\n`;

                response += `🔍 [View on Etherscan](${transactionLink})\n\n`;
                
                sendViaMainBot(
                    chatId, 
                    response,
                    `.src/genie prof pic.png`,
                    'Markdown'
                );

                console.log("Success");
            } catch (error) {
                await bot.sendMessage(userChatId, 'Your transaction experienced an ERROR, please try again. Check for your settings!');
                if (error.message.includes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT")) {
                    await bot.sendMessage(userChatId, "Transaction failed. Please adjust your slippage.");
                } else {
                    console.error('Error executing Uniswap transaction:', error);
                }

            }

        }
    }
});

// bot.onText(/^\/?(0x[0-9a-fA-F]{40})$/i, async (msg, match) => {
//     if (msg.chat.type === 'private') {
//     const address = match[1];

//     if (!ethers.utils.isAddress(address)) {
//       return bot.sendMessage(msg.from.id, 'Invalid Ethereum address.');
//     }

//     try {
//       const result = await checkHoneypot(address);

//       const message = await formatResultMessage(result);
//       console.log("message: ", message);
//       bot.sendMessage(msg.from.id, message, { parse_mode: 'Markdown' });
//     } catch (error) {
//       bot.sendMessage(msg.from.id, 'Error checking honeypot status.');
//     }
//     }
// });

bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    const callbackId = callbackQuery.id;

    if (callbackThrottle[callbackId] && Date.now() - callbackThrottle[callbackId] < 5000) {
        return;
    }
    try {
        const parts = data.split('_');

        let interactionId = parts.slice(parts.length-2).join('_');
        let interaction = interactions[interactionId];
        let username = interaction.username;
        console.log(username);
        console.log(data);

        const action = parts[0];

            if (!interaction) {
                console.log(`Transaction ${username} not found.`);
                return;
            }

            if (action === 'create') {
                const existingWallet = await getAsync(`wallets:${username}`);
                let sentConfirmationMessage = '';
                if (existingWallet){
                const confirmationMessage = `Are you sure you want to create a new wallet? Your old wallet will be permanently lost.`;

                const confirmationKeyboard = {
                    keyboard: [
                        [{ text: 'Yes, I confirm' }],
                        [{ text: 'No, cancel' }],
                    ],
                    one_time_keyboard: true,
                    resize_keyboard: true,
                };

                 sentConfirmationMessage = await bot.sendMessage(chatId, confirmationMessage, { reply_markup: JSON.stringify(confirmationKeyboard) });

                bot.once('text', async (msg) => {
                    const userResponse = msg.text;

                    if (userResponse === 'Yes, I confirm') {
                        const wallet = new ethers.Wallet.createRandom();
                        const address = wallet.address;
                        const privateKey = wallet.privateKey.substring(2);

                        const response = `🆕 *New Wallet Created* 🆕\n\n` +
                            `💼 *Address:* ${address}\n\n` +
                            `🔑 *Private Key:* ${privateKey}`;

                        await setAsync(`wallets:${username}`, JSON.stringify({ address, privateKey }));
                        await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
                    } else if (userResponse === 'No, cancel') {
                        await bot.sendMessage(chatId, 'Wallet creation canceled.');
                    }
                    if(sentConfirmationMessage != null){
                    await bot.deleteMessage(chatId, sentConfirmationMessage.message_id);
                    }
                });
                } else {
                    const wallet = new ethers.Wallet.createRandom();
                    const address = wallet.address;
                    const privateKey = wallet.privateKey.substring(2);

                    const response = `🆕 *New Wallet Created* 🆕\n\n` +
                        `💼 *Address:* ${address}\n\n` +
                        `🔑 *Private Key:* ${privateKey}`;

                    await setAsync(`wallets:${username}`, JSON.stringify({ address, privateKey }));
                    await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
                }
            }

            if (action === 'import') {
                const existingWallet = await getAsync(`wallets:${username}`);
                if (existingWallet){
                const confirmationMessage = `Are you sure you want to import a wallet? Your current wallet will be permanently replaced.`;

                const confirmationKeyboard = {
                    keyboard: [
                        [{ text: 'Yes, I confirm' }],
                        [{ text: 'No, cancel' }],
                    ],
                    one_time_keyboard: true,
                    resize_keyboard: true,
                };

                const sentConfirmationMessage = await bot.sendMessage(chatId, confirmationMessage, { reply_markup: JSON.stringify(confirmationKeyboard) });

                bot.once('text', async (confirmationMsg) => {
                    const userConfirmation = confirmationMsg.text;

                    if (userConfirmation === 'Yes, I confirm') {
                        const importMessage = `Please enter your private key to import your wallet.`;

                        const sendMessageOptions = {
                            reply_markup: {
                                force_reply: true,
                            },
                        };

                        const sentMessage = await bot.sendMessage(chatId, importMessage, sendMessageOptions);

                        bot.onReplyToMessage(chatId, sentMessage.message_id, async (msg) => {
                            const userResponse = msg.text;

                            console.log('Received user response:', userResponse);

                            try {
                                const userEnteredPrivateKey = Uint8Array.from(Buffer.from(userResponse, 'hex'));

                                if (userEnteredPrivateKey instanceof Uint8Array && userEnteredPrivateKey.length === 32) {
                                    const wallet = new Wallet(userEnteredPrivateKey);
                                    const walletInfo = {
                                        address: wallet.address,
                                        privateKey: wallet.privateKey.substring(2)
                                    };

                                    await setAsync(`wallets:${username}`, JSON.stringify(walletInfo));
                                    await bot.sendMessage(chatId, `Your wallet has been imported successfully.`);
                                } else {
                                    await bot.sendMessage(chatId, 'Invalid private key format. Private keys must be a random 256-bit blob.');
                                }
                            } catch (error) {
                                console.error('Error importing wallet:', error);
                                await bot.sendMessage(chatId, `Error importing wallet. Please check the provided private key.`);
                            }
                        });

                    } else if (userConfirmation === 'No, cancel') {
                        await bot.sendMessage(chatId, 'Wallet import canceled.');
                    }

                    if(sentConfirmationMessage!= null){
                    await bot.deleteMessage(chatId, sentConfirmationMessage.message_id);
                    }
                });
                } else{
                    const importMessage = `Please enter your private key to import your wallet.`;

                        const sendMessageOptions = {
                            reply_markup: {
                                force_reply: true,
                            },
                        };
                        const sentMessage = await bot.sendMessage(chatId, importMessage, sendMessageOptions);
                        bot.onReplyToMessage(chatId, sentMessage.message_id, async (msg) => {
                            const userResponse = msg.text;

                            console.log('Received user response:', userResponse);

                            try {
                                const userEnteredPrivateKey = Uint8Array.from(Buffer.from(userResponse, 'hex'));

                                if (userEnteredPrivateKey instanceof Uint8Array && userEnteredPrivateKey.length === 32) {
                                    const wallet = new Wallet(userEnteredPrivateKey);
                                    const walletInfo = {
                                        address: wallet.address,
                                        privateKey: wallet.privateKey.substring(2)
                                    };

                                    await setAsync(`wallets:${username}`, JSON.stringify(walletInfo));
                                    await bot.sendMessage(chatId, `Your wallet has been imported successfully.`);
                                } else {
                                    await bot.sendMessage(chatId, 'Invalid private key format. Private keys must be a random 256-bit blob.');
                                }
                            } catch (error) {
                                console.error('Error importing wallet:', error);
                                await bot.sendMessage(chatId, `Error importing wallet. Please check the provided private key.`);
                            }
                        });
                }
            }

            if (action === 'info') {
                try {
                    const walletInfoString = await getAsync(`wallets:${interactions[interactionId].username}`);

                    if (!walletInfoString) {
                        bot.sendMessage(chatId, "You have no wallet set up.");
                        return "Wallet information not found for this user.";
                    }

                    const walletInfo = JSON.parse(walletInfoString);
                    const walletAddress = walletInfo.address;

                    const balanceWei = await provider.getBalance(walletAddress);
                    const balanceEther = ethers.utils.formatEther(balanceWei);

                    const ethToUsdExchangeRate = await fetchEthToUsdExchangeRate();

                    const balanceUsd = (parseFloat(balanceEther) * ethToUsdExchangeRate).toFixed(2);

                    let response = `═══ Your Wallets ═══\n` +
                    `▰ Wallet ▰\n` +
                    `Wallet: ${walletAddress}\n` +
                    `Bal: ${balanceEther} ETH ($${balanceUsd})\n`;


                    const channelKeys = await keysAsync('channel:*');
                    for (const channelKey of channelKeys) {
                        const contractAddress = await getAsync(channelKey);
                        const tokenContract = new ethers.Contract(
                            contractAddress,
                            [
                              'function symbol() view returns (string)',
                              'function balanceOf(address account) view returns (uint256)',
                            ],
                            provider
                          );
                        try {
                            const tokenSymbol = await tokenContract.symbol();

                            const userBalanceWei = await tokenContract.balanceOf(walletAddress);
                            const userBalanceToken = userBalanceWei / 1e9;

                            console.log(`Contract Address: ${contractAddress}, Token Symbol: ${tokenSymbol}`);
                            if(userBalanceToken>0){
                            response += `\n${tokenSymbol} Bal: ${userBalanceToken} $${tokenSymbol}`;
                            }
                          } catch (error) {
                            console.error(`Error fetching data for contract address ${contractAddress}:`, error);
                          }
                    }

                    const keyboard = {
                        inline_keyboard: [
                            [{ text: 'Show Private Key', callback_data: `showPrivateKey_${username}_${interactionId}` }],
                        ],
                    };

                    await bot.sendMessage(chatId, response, { parse_mode: 'HTML', reply_markup: keyboard });

                } catch (error) {
                    console.error('Error fetching wallet information:', error);
                    return "An error occurred while fetching wallet information.";
                }
            }

            if (action === 'settings') {
                const savedSettingsGasBufferString = await getAsync(`settings:gas_buffer:${interaction.username}`);
                const savedSettingsSlippageString = await getAsync(`settings:slippage:${interaction.username}`);

                try {
                    const savedGasBufferSettings = savedSettingsGasBufferString ? JSON.parse(savedSettingsGasBufferString) : null;
                    const savedSlippageSettings = savedSettingsSlippageString ? JSON.parse(savedSettingsSlippageString) : null;

                    const settingsKeyboard = {
                        inline_keyboard: [
                            [{ text: 'Set Gas Buffer', callback_data: `set_gas_buffer_${username}_${interactionId}` }],
                            [{ text: 'Set Slippage', callback_data: `set_slippage_${username}_${interactionId}` }],
                        ]
                    };

                    const gasBuffer = savedGasBufferSettings ? savedGasBufferSettings.gasBuffer + '%' : '10%';
                    const slippage = savedSlippageSettings ? savedSlippageSettings.slippage + '%' : '3%';  

                    const message = `Your current settings:\n\nGas Buffer: ${gasBuffer}\nSlippage: ${slippage}`;
                    const message1 = await bot.sendMessage(chatId, message, { reply_markup: JSON.stringify(settingsKeyboard) });
                    lastMessageId1 = message1.message_id;                } catch (error) {
                    console.error("Error: Retry /start", error);
                    await bot.sendMessage(chatId, "An error occurred while retrieving your settings. Please try again later.");
                }
            }

            if(action === 'asell') {
                try {
                    storedSymbol[username] = [];
                    const walletInfoString = await getAsync(`wallets:${interactions[interactionId].username}`);

                    if (!walletInfoString) {
                        bot.sendMessage(chatId, "You have no wallet set up.");
                        return "Wallet information not found for this user.";
                    }

                    const walletInfo = JSON.parse(walletInfoString);
                    const walletAddress = walletInfo.address;

                    let response = `═══ Your Wallets ═══\n` +
                    `▰ Holdings ▰\n`

                    const channelKeys = await keysAsync('channel:*');
                    for (const channelKey of channelKeys) {
                        const contractAddress = await getAsync(channelKey);
                        const tokenContract = new ethers.Contract(
                            contractAddress,
                            [
                              'function symbol() view returns (string)',
                              'function balanceOf(address account) view returns (uint256)',
                            ],
                            provider
                          );
                        try {
                            const tokenSymbol = await tokenContract.symbol();

                            const userBalanceWei = await tokenContract.balanceOf(walletAddress);
                            const userBalanceToken = userBalanceWei / 1e9;

                            console.log(`Contract Address: ${contractAddress}, Token Symbol: ${tokenSymbol}`);
                            if(userBalanceToken>0){
                            response += `\n${tokenSymbol} Bal: ${userBalanceToken} $${tokenSymbol}`;
                            storedSymbol[username].push({ symbol: tokenSymbol, address: contractAddress });

                            }
                          } catch (error) {
                            console.error(`Error fetching data for contract address ${contractAddress}:`, error);
                          }
                    }
                    console.log(storedSymbol[username]);
                    const inlineKeyboard = [];

                    for (const entry of storedSymbol[username]) {
                        const { symbol, address } = entry;
                        const button = {
                            text: `Sell $${symbol}`,
                            callback_data: `sell_symbol_${symbol}_${username}_${interactionId}`,
                        };

                        inlineKeyboard.push([button]);
                    }

                    const keyboard = {
                        inline_keyboard: inlineKeyboard,
                    };

                   const message = await bot.sendMessage(chatId, response, { parse_mode: 'HTML', reply_markup: keyboard });
                   lastMessageId1 = message.message_id;
                } catch (error) {
                    console.error('Error fetching wallet information:', error);
                    return "An error occurred while fetching wallet information.";
                }
            }

            if (data.startsWith('set_gas_buffer_')) {
                const gasBufferKeyboard = {
                    inline_keyboard: [
                        [
                            { text: '5%', callback_data: `gas_buffer_5_${username}_${interactionId}` },
                            { text: '10%', callback_data: `gas_buffer_10_${username}_${interactionId}` }
                        ],
                        [
                            { text: '20%', callback_data: `gas_buffer_20_${username}_${interactionId}` },
                            { text: '40%', callback_data: `gas_buffer_40_${username}_${interactionId}` }
                        ],
                        [
                            { text: 'custom', callback_data: `custom_gas_${username}_${interactionId}` }
                        ]
                    ]
                };
                if (lastMessageId1!= null) {
                    await bot.deleteMessage(chatId, lastMessageId1);
                }
                const message2 = await bot.sendMessage(chatId, 'Select your Gas Buffer:', { reply_markup: JSON.stringify(gasBufferKeyboard) });
                lastMessageId1 = message2.message_id;
            } else if (data.startsWith('set_slippage_')) {
                const slippageKeyboard = {
                    inline_keyboard: [
                        [
                            { text: '3%', callback_data: `slippage_3_${username}_${interactionId}` },
                            { text: '5%', callback_data: `slippage_5_${username}_${interactionId}` }
                        ],
                        [
                            { text: '10%', callback_data: `slippage_10_${username}_${interactionId}` },
                            { text: '30%', callback_data: `slippage_30_${username}_${interactionId}` }
                        ],
                        [
                            { text: 'custom', callback_data: `custom_slippage_${username}_${interactionId}` }
                        ]
                    ]
                };
                if (lastMessageId1!= null) {
                    await bot.deleteMessage(chatId, lastMessageId1);
                }
                const message2 = await bot.sendMessage(chatId, 'Select your Slippage:', { reply_markup: JSON.stringify(slippageKeyboard) });
                lastMessageId1 = message2.message_id;
            }

            if (data.startsWith('custom_slippage_')) {
                const importMessage = `Please Enter your slippage (1-100).`;

                const sendMessageOptions = {
                    reply_markup: {
                        force_reply: true,
                    },
                };

                const sentMessage = await bot.sendMessage(chatId, importMessage, sendMessageOptions);

                bot.onReplyToMessage(chatId, sentMessage.message_id, async (msg) => {
                    const userResponse = msg.text;

                    console.log('Received user response:', userResponse);

                    try {
                        const slippage = parseFloat(userResponse);

                        if (!isNaN(slippage) && slippage >= 1 && slippage <= 100) {
                            console.log('Slippage value:', slippage);
                            await setAsync(`settings:slippage:${username}`, JSON.stringify({ slippage }));
                            await bot.sendMessage(chatId, `Slippage of ${slippage}% has been set.`);
                        } else {
                            await bot.sendMessage(chatId, 'Invalid slippage value. Please enter a number between 1 and 100.');
                        }
                    } catch (error) {
                        console.error('Error processing slippage value:', error);
                        await bot.sendMessage(chatId, 'Error processing slippage value. Please try again.');
                    }
                });
                if (lastMessageId1!= null) {
                    await bot.deleteMessage(chatId, lastMessageId1);
                }

            }

            if (data.startsWith('custom_gas_')) {
                const importMessage = `Please Enter your Gas Buffer (1-100).`;

                const sendMessageOptions = {
                    reply_markup: {
                        force_reply: true,
                    },
                };

                const sentMessage = await bot.sendMessage(chatId, importMessage, sendMessageOptions);

                bot.onReplyToMessage(chatId, sentMessage.message_id, async (msg) => {
                    const userResponse = msg.text;

                    console.log('Received user response:', userResponse);

                    try {
                        const gasBuffer = parseFloat(userResponse);

                        if (!isNaN(gasBuffer) && gasBuffer >= 1 && gasBuffer <= 100) {
                            console.log('Gas Buffer value:', gasBuffer);
                            await setAsync(`settings:gas_buffer:${username}`, JSON.stringify({ gasBuffer }));
                            await bot.sendMessage(chatId, `gasBuffer of ${gasBuffer}% has been set.`);
                        } else {
                            await bot.sendMessage(chatId, 'Invalid gasBuffer value. Please enter a number between 1 and 100.');
                        }
                    } catch (error) {
                        console.error('Error processing gasBuffer value:', error);
                        await bot.sendMessage(chatId, 'Error processing gasBuffer value. Please try again.');
                    }
                });
                if (lastMessageId1!= null) {
                    await bot.deleteMessage(chatId, lastMessageId1);
                }

            }

            if (data.startsWith('showPrivateKey_')) {
                try {
                    const walletInfoString = await getAsync(`wallets:${username}`);

                    if (!walletInfoString) {
                        bot.sendMessage(chatId, "No wallet information found.");
                        return;
                    }

                    const walletInfo = JSON.parse(walletInfoString);
                    const privateKey = walletInfo.privateKey;

                    const replyMessage = await bot.sendMessage(chatId, `Private Key: ${privateKey}`, {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Delete', callback_data: `deleteMessage_${username}_${interactionId}` }],
                            ],
                        },
                    });
                    lastMessageId2 = replyMessage.message_id;
                    console.log(lastMessageId2);
                } catch (error) {
                    console.error('Error retrieving and showing private key:', error);
                    bot.sendMessage(chatId, "An error occurred while retrieving the private key.");
                }
            }

            if (data.startsWith('deleteMessage_')) {
            console.log(lastMessageId2);
                if (lastMessageId2) {
                    try {
                        await bot.deleteMessage(chatId, lastMessageId2);
                    } catch (error) {
                        console.error('Error deleting message:', error);
                    }
                }
            }

            if (data.startsWith('sell_symbol_')) {
                const symbol = parts[2];

                const sellNowKeyboard = {
                    inline_keyboard: [
                        [
                            { text: '5%', callback_data: `sell_now_5_${symbol}_${username}_${interactionId}` },
                            { text: '10%', callback_data: `sell_now_10_${symbol}_${username}_${interactionId}` }
                        ],
                        [
                            { text: '50%', callback_data: `sell_now_50_${symbol}__${username}_${interactionId}` },
                            { text: '100%', callback_data: `sell_now_100_${symbol}_${username}_${interactionId}` }
                        ],
                        [
                            { text: 'custom', callback_data: `sell_now_custom_${symbol}_${username}_${interactionId}` }
                        ]
                    ]
                };

                if (lastMessageId1!= null) {
                    await bot.deleteMessage(chatId, lastMessageId1);
                }

                const message2 = await bot.sendMessage(chatId, 'Select sell Amount:', { reply_markup: JSON.stringify(sellNowKeyboard) });
                lastMessageId1 = message2.message_id;
            }

            if (data.startsWith('sell_now_')) {
                if (lastMessageId1!= null) {
                    await bot.deleteMessage(chatId, lastMessageId1);
                }
                let sellPercent;
                console.log("parts[2] ", parts[2]);
                if (parts[2] === 'custom') {
                    const importMessage = `Please enter your desired sell amount in % (1 - 100) e.g: 55%`;
            
                    const sendMessageOptions = {
                        reply_markup: {
                            force_reply: true,
                        },
                    };
            
                    console.log("debug");
                    const sentMessage = await bot.sendMessage(chatId, importMessage, sendMessageOptions);
                    console.log("debug");
            
                    const replyPromise = new Promise((resolve) => {
                        bot.onReplyToMessage(chatId, sentMessage.message_id, async (msg) => {
                            const userResponse = msg.text;
                            console.log('Received user response:', userResponse);
                            const enteredPercentage = parseFloat(userResponse);
            
                            if (isNaN(enteredPercentage) || enteredPercentage < 1 || enteredPercentage > 100) {
                                const errorMessage = `Invalid input. Please enter a percentage between 1 and 100. Retry /start.`;
                                await bot.sendMessage(chatId, errorMessage);
                                bot.sendMessage(chatId, `Sell Amount of ${sellPercent} was initiated`);
                            } else {
                                sellPercent = enteredPercentage;
                            }
            
                            resolve();
                        });
                    });

                    await replyPromise;
                } else {
                    sellPercent = parts[2];
                }
                const userChatId = await getAsync(`chatID:${username}`);
                const safeUsername = username.replace(/_/g, '\\_');
                const symbol = parts[3];
                console.log(storedSymbol);
                console.log(username);
                const entryArray = storedSymbol[username];
                let address = null;
                if (entryArray && entryArray.length > 0) {
                  for (let user of entryArray) {
                    if (user.symbol === symbol) {
                        address = user.address;
                      console.log(address);
                    }
                  }
                } else {
                  console.log('Entry not found for the given username.');
                }

                  const walletInfoString = await getAsync(`wallets:${username}`);
                  console.log('Wallet Info String:', walletInfoString);

                  const walletInfo = JSON.parse(walletInfoString);
                  console.log('Wallet Info:', walletInfo);

                  const privateKey = walletInfo.privateKey;
                  console.log('Private Key:', privateKey);

                  const wallet = new ethers.Wallet(privateKey, provider);
                  console.log('Wallet Address:', wallet.address);
                  const nonce = await wallet.getTransactionCount();
                  console.log("nonce: ", nonce);
                  const tokenContract = new ethers.Contract(
                    address,
                    [
                        'function symbol() view returns (string)',
                        'function balanceOf(address account) view returns (uint256)',
                        'function approve(address spender, uint256 amount) external returns (bool)',
                        'function allowance(address owner, address spender) view returns (uint256)',
                      ],
                    wallet
                  );

                  const userBalanceWei = await tokenContract.balanceOf(walletInfo.address);
                  console.log('User Balance in Wei:', userBalanceWei.toString());

                  const userBalanceToken = userBalanceWei.div(ethers.BigNumber.from(1e9));
                  console.log('User Balance in Tokens:', userBalanceToken.toString());

                  const userBalanceTokenToSell = userBalanceToken
                  .mul(sellPercent)
                  .div(ethers.BigNumber.from(100))
                  .mul(ethers.BigNumber.from(1e9))
                  .toString();  

                  console.log('User Balance to Sell in Tokens:', userBalanceTokenToSell);

                  const slippage = await getAsync(`settings:slippage:${username}`);
                  const slippagePercentage = parseFloat(JSON.parse(slippage).slippage);
                  console.log('Slippage Percentage:', slippagePercentage);

                  const slippageAdjustedPercentage = 100 - slippagePercentage;
                  console.log('Slippage Adjusted Percentage:', slippageAdjustedPercentage);

                  const mainWethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
                  const goerliWethAddress = '0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6';
                  const gasPrice = await provider.getGasPrice();
                  const path = [address, goerliWethAddress];
                  const uniswapRouterAddress = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
                  const uniswapRouterAbi = [
                    {
                      "constant": false,
                      "inputs": [
                        {"name": "amountIn", "type": "uint256"},
                        {"name": "amountOutMin", "type": "uint256"},
                        {"name": "path", "type": "address[]"},
                        {"name": "to", "type": "address"},
                        {"name": "deadline", "type": "uint256"}
                      ],
                      "name": "swapExactTokensForETHSupportingFeeOnTransferTokens",
                      "outputs": [],
                      "payable": false,
                      "stateMutability": "nonpayable",
                      "type": "function"
                    },
                    {
                      "constant": true,
                      "inputs": [
                        {"name": "amountIn", "type": "uint256"},
                        {"name": "path", "type": "address[]"}
                      ],
                      "name": "getAmountsOut",
                      "outputs": [
                        {"name": "", "type": "uint256[]"}
                      ],
                      "payable": false,
                      "stateMutability": "view",
                      "type": "function"
                    }
                  ];
                  
                  const uniswapRouter = new ethers.Contract(uniswapRouterAddress, uniswapRouterAbi, wallet);

                  const amountIn = userBalanceTokenToSell;
                  const amountOut = await uniswapRouter.getAmountsOut(amountIn, path); 
                  const amountOutMinWithSlippage = Math.round(amountOut[1] *  slippageAdjustedPercentage / 100 / 1e9);
                  console.log('Amount Out Min with Slippage:', amountOutMinWithSlippage);

                const balanceWei = await provider.getBalance(walletInfo.address);
                const balanceEther = ethers.utils.formatEther(balanceWei);
              
                let gasBuffer = await getAsync(`settings:gas_buffer:${username}`);
                gasBuffer = JSON.parse(gasBuffer).gasBuffer;

                console.log('Balance in Ether:', balanceEther);

                let allowance = await tokenContract.allowance(
                    walletInfo.address,
                    uniswapRouterAddress
                );

                console.log("allowance: ", allowance.toString());
                console.log("usertokentosell: ", userBalanceTokenToSell);

                if (!allowance.gte(userBalanceTokenToSell)) {
                    const unlimitedAllowance = ethers.constants.MaxUint256;
                
                    const estimatedGasApprove = await tokenContract.estimateGas.approve(
                        uniswapRouterAddress,
                        unlimitedAllowance,
                    );
                    console.log("estimatedGasApprove: ", estimatedGasApprove);
                
                    const increasedEstimatedGasApprove = Math.ceil(estimatedGasApprove.toNumber() * (1 + gasBuffer / 100));
                
                    const approvalTx = await tokenContract.approve(
                        uniswapRouterAddress,
                        unlimitedAllowance,
                        { gasLimit: increasedEstimatedGasApprove }
                    );
                
                    const approvalLink = `https://goerli.etherscan.io/tx/${approvalTx.hash}`;
                    const APPMessage = `Your approval link: [View on Etherscan](${approvalLink})`;
                
                    await bot.sendMessage(chatId, APPMessage, { parse_mode: 'Markdown' });
                
                    await approvalTx.wait();
                
                    allowance = await tokenContract.allowance(
                        walletInfo.address,
                        uniswapRouterAddress
                    );
                
                    if (allowance.gte(userBalanceTokenToSell)) {
                        console.log("Approval successful!");
                    } else {
                        console.log("Approval not successful. Please check the allowance.");
                    }
                }
                
                console.log("nonce: ", nonce);
                const estimatedGas = await uniswapRouter.estimateGas.swapExactTokensForETHSupportingFeeOnTransferTokens(
                    userBalanceTokenToSell.toString(),
                    amountOutMinWithSlippage.toString(),
                    path,
                    wallet.address,
                    Date.now() + 1000 * 60 * 10,
                );

                console.log('Estimated Gas:', estimatedGas.toString());
                
                const increasedGasPrice = Math.ceil(gasPrice * (1 + gasBuffer / 100) * (ethers.BigNumber.from(1e9)));
                const gasLimit = Math.ceil(estimatedGas.toNumber() * (1 + gasBuffer / 100));
                const gasPriceInGwei = ethers.BigNumber.from(increasedGasPrice);
                const gasLimitBN = ethers.BigNumber.from(gasLimit);

                const gasCost = gasPriceInGwei.mul(gasLimitBN);
                console.log('Gas Cost:', gasCost.toString());

                const totalMaxCostInEth = ethers.utils.formatEther(gasCost);
                console.log('Total Max Cost:', totalMaxCostInEth);
                    console.log("balanceEther: ", balanceEther);
                if(balanceEther<=totalMaxCostInEth){
                    bot.sendMessage(userChatId, `@${safeUsername} Funds too low!`, { parse_mode: 'Markdown' });
                    return;
                }

                console.log('Gas Cost:', gasCost.toString());
                console.log("nonce: ", nonce);
                const transaction = await uniswapRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
                    userBalanceTokenToSell.toString(),
                    amountOutMinWithSlippage.toString(),
                    path,
                    wallet.address,
                    Date.now() + 1000 * 60 * 10,
                    { gasLimit: gasLimit, gasPrice: increasedGasPrice}
                );

                const transactionLink = `https://goerli.etherscan.io/tx/${transaction.hash}`;
                const TXMessage = `Your transaction link: [View on Etherscan](${transactionLink})`;

                await bot.sendMessage(chatId, TXMessage, { parse_mode: 'Markdown' });

                await transaction.wait();

                const successMessage = `Your sell transaction was successful!`;
                bot.sendMessage(chatId, successMessage, { parse_mode: 'Markdown' });

                console.log('Transaction Hash:', transaction.hash);
            }

            if (data.startsWith('gas_buffer_')) {
                const gasBuffer = parseInt(parts[2]);
                await setAsync(`settings:gas_buffer:${username}`, JSON.stringify({ gasBuffer }));
                await bot.sendMessage(chatId, `Gas Buffer set to ${gasBuffer}%`);
                if (lastMessageId1!= null) {
                    await bot.deleteMessage(chatId, lastMessageId1);
                }

            } else if (data.startsWith('slippage_')) {
                const slippage = parseInt(parts[1]);
                await setAsync(`settings:slippage:${username}`, JSON.stringify({ slippage }));
                await bot.sendMessage(chatId, `Slippage set to ${slippage}%`);
                console.log(lastMessageId1);
                if (lastMessageId1!= null) {
                    await bot.deleteMessage(chatId, lastMessageId1);
                }

            }

        } catch (error) {
            console.error('Error in callback query handler:', error);
            bot.sendMessage(chatId, "ERROR, retry /start", { parse_mode: 'Markdown' });
        }
});

function shortenWalletAddress(walletAddress) {
    const firstPart = walletAddress.substring(0, 6);
    const lastPart = walletAddress.substring(walletAddress.length - 4);
    return `${firstPart}...${lastPart}`;
}
async function fetchEthToUsdExchangeRate() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
        const ethToUsdRate = response.data.ethereum.usd;

        return ethToUsdRate;
    } catch (error) {
        console.error('Error fetching ETH to USD exchange rate:', error);
        throw error;
    }
}
async function checkHoneypot(address) {
    try {
      const response = await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${address}`);
      const data = await response.json();
      console.log(data);
      return data;
    } catch (error) {
      console.error('Error checking honeypot:', error);
      throw error;
    }
}
async function formatResultMessage(result) {
    const token = result.token;
    const honeypotResult = result.honeypotResult;
    console.log(result.pair.pair.address);

    const reserve0 = result.pair.reserves0;
    const reserve1 = result.pair.reserves1;

    console.log(reserve0);
    console.log(reserve1);

    if (reserve0 === 0 || reserve1 === 0) {
        throw new Error('Reserve values are zero, potential division by zero');
    }
    console.log("debug");
    const tokenPriceInEth = (reserve1) / (reserve0);
    const currentTokenPrice = tokenPriceInEth;
    console.log('Token Price in ETH:', currentTokenPrice);
    console.log("debug");
    const currentTokenPriceUSD = await fetchEthToUsdExchangeRate() * currentTokenPrice;
    console.log("debug");
    const tokenABI = [' function totalSupply() external view returns (uint256)'];
    console.log("debug");
    const TokenContract = new ethers.Contract(token.address, tokenABI, provider);
    console.log("debug");
    console.log("token.address: ", token.address);

        // let totalSupply;

        // try {
        // totalSupply = await TokenContract.totalSupply() / 1e9;
        // } catch (error) {
        // console.error('Error fetching total supply:', error);
        // // Handle the error as needed, e.g., set totalSupply to a default value or rethrow the error.
        // }

    console.log("debug");
    const formattedMessage = `🔬  [${token.name} (${token.symbol})](https://etherscan.io/token/${token.address})  -  Chain: ${result.chain.currency}  🔬\n\n` +
        `Links: [Etherscan](https://etherscan.io/token/${token.address})  -  [📈Chart](https://geckoterminal.com/eth/tokens/${token.address})\n` +
        `Supply: ${totalSupply} ⬩ Decimals: ${token.decimals}\n` +
        `Marketcap: $${calculateMarketcap(currentTokenPriceUSD, totalSupply)}\n` +
        `Price: $${currentTokenPriceUSD}\n` +
        `CA: [${token.address}](https://etherscan.io/address/${token.address})\n` +
        `Buy Tax: ${result.simulationResult.buyTax}%\n` +
        `Sell Tax: ${result.simulationResult.sellTax}%\n` +
        `Transfer Tax: ${result.simulationResult.transferTax}%\n\n` +
        `${honeypotResult.isHoneypot ? 'Seems like a honeypot' : 'Doesn\'t seem like a honeypot'} [🍯](https://honeypot.is/ethereum?address=${token.address}) ${honeypotResult.isHoneypot ? '❌' : '✅'}`;
        console.log("debug");
    return formattedMessage;
}
async function getEthGainedFromTransaction(txHash) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);

        if (receipt && receipt.status === 1) {
            // Find the "Transfer" event dynamically based on the event signature
            const transferEvent = receipt.logs.find(log => {
                const parsedLog = ethers.utils.defaultAbiCoder.parse(
                    ['address', 'address', 'uint256'],
                    log.data
                );

                const transferEventSignature = 'Transfer(address,address,uint256)';
                return log.topics[0] === ethers.utils.id(transferEventSignature);
            });

            if (transferEvent) {
                // Extract the amount of ETH transferred
                const ethTransferred = ethers.utils.formatUnits(transferEvent.data, 'wei');
                return parseFloat(ethTransferred);
            } else {
                console.error("Unable to find Transfer event in transaction logs.");
                return null;
            }
        } else {
            console.error("Sell transaction failed or not confirmed.");
            return null;
        }
    } catch (error) {
        console.error("Error while retrieving transaction receipt:", error);
        return null;
    }
}
async function sendViaMainBot(chatId, text, animationPath = null, parseMode = null) {
    try {
        if (animationPath) {
            const formData = new FormData();
            formData.append('chat_id', chatId);
            formData.append('animation', fs.createReadStream(animationPath));
            formData.append('caption', text);
            formData.append('parse_mode', parseMode || 'Markdown');

            const response = await axios.post(TELEGRAM_BASE_URL + 'sendAnimation', formData, {
                headers: {
                    ...formData.getHeaders(),
                },
            });
            console.log("Animation (GIF) with caption sent:", response.data);
        } else {
            const response = await axios.post(TELEGRAM_BASE_URL + 'sendMessage', {
                chat_id: chatId,
                text: text,
                parse_mode: parseMode || 'Markdown',
            });
            console.log("Message sent:", response.data);
        }
    } catch (error) {
        console.error("Failed to send message:", error);
    }
}
function generateBuyEmojis(amount, mcap) {
    const ratio = amount / mcap;
    const emojisCount = Math.max(1, Math.ceil(ratio / 0.1));
    const finalCount = Math.min(amount, emojisCount);

    return '🧞‍♂️'.repeat(finalCount);
}
