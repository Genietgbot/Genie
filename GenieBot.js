require('dotenv').config();
const { ethers, Wallet, utils } = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
const token = process.env.BOT_TOKEN;
const redis = require('redis');
const axios = require('axios');
const bluebird = require('bluebird');
const bot = new TelegramBot(token, { polling: true });
const redisUrl = process.env.REDIS_URL;
const provider = new ethers.providers.JsonRpcProvider(process.env.GOERLI_PROVIDER_URL);
process.env.NTBA_FIX_350 = true;
const sharp = require('sharp');
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
const delAsync = bluebird.promisify(client.del).bind(client);

const resizeImage = async (imagePath, outputPath, width, height) => {
    await sharp(imagePath)
        .resize(width, height)
        .toFile(outputPath);
};

let interactions = {};
const callbackThrottle = {};
let lastMessageId1 = null; 
let lastMessageId2 = null; 
let lastMessageId3 = null;

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
        
        let response = `🧞‍♂️ Welcome to the Genie Wish Maker Bot, @${safeUsername}! 🧞‍♂️\n\n`;

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
            throw new Error('Invalid buy amount.');
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
                const uniswapRouterAbi = ['function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable returns (uint256[] memory amounts)'];
                const uniswapRouter = new ethers.Contract(uniswapRouterAddress, uniswapRouterAbi, wallet);
            
                const tokenToBuyAddress = contractAddress;
                const mainWethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; 
                const goerliWethAddress = '0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6';
                const path = [goerliWethAddress, tokenToBuyAddress];
                const slippagePercentage = parseFloat(JSON.parse(slippage).slippage);

                gasBuffer = JSON.parse(gasBuffer).gasBuffer;
                console.log("gasbuffer: ", gasBuffer);
                console.log("debug");
                console.log('Amount to Buy:', amountToBuy);
                console.log('Slippage Percentage:', slippagePercentage);
                await bot.sendMessage(userChatId, 'Your transaction was initiated!');
                
                const amountOutMinWithSlippage = ethers.utils.parseUnits(
                    (amountToBuy * (1 - slippagePercentage / 100)).toString(),
                    'ether'
                );

                console.log("debug");
                console.log('AmountOutMin with Slippage:', amountOutMinWithSlippage.toString());

                const gasPrice = await provider.getGasPrice();
                console.log('Current Gas Price:', gasPrice.toString());

                const estimatedGas = await uniswapRouter.estimateGas.swapExactETHForTokens(
                    0,
                    path,
                    wallet.address,
                    Date.now() + 1000 * 60 * 2,
                    { value: ethers.utils.parseEther(amountToBuy.toString()) }
                );

                if(balanceEther<=amountToBuy){
                    bot.sendMessage("Funds to low!");
                    return;
                }

                const increasedGasPrice = Math.ceil(gasPrice * (1 + gasBuffer / 100) * (ethers.BigNumber.from(1e9)));
                console.log(increasedGasPrice);
                console.log('Estimated Gas:', estimatedGas.toString());

                const gasLimit = Math.ceil(estimatedGas.toNumber() * (1 + gasBuffer / 100));
                console.log('Calculated Gas Limit:', gasLimit);

                if (gasLimit <= 0) {
                    console.error('Invalid Gas Limit:', gasLimit);
                    throw new Error('Invalid Gas Limit');
                }

                const totalMaxCost = increasedGasPrice * gasLimit / ethers.BigNumber.from(1e9);
                console.log(totalMaxCost.toString());
                
                
                const transaction = await uniswapRouter.swapExactETHForTokens(
                    amountOutMinWithSlippage,
                    path,
                    wallet.address,
                    Date.now() + 1000 * 60 * 2,
                    { gasLimit, gasPrice: increasedGasPrice, value: ethers.utils.parseEther(amountToBuy.toString()) }
                );
                const transactionLink = `https://goerli.etherscan.io/tx/${transaction.hash}`;
                const message = `Your transaction link: [View on Etherscan](${transactionLink})`;
                
                await bot.sendMessage(userChatId, message, { parse_mode: 'Markdown' });
                await transaction.wait();
                await bot.sendMessage(userChatId, 'Your transaction was successful!');
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
                        const privateKey = wallet.privateKey;
            
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
                    const privateKey = wallet.privateKey;
        
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
                                        privateKey: wallet.privateKey
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
                                // Convert the user response (hexadecimal string) to a Uint8Array
                                const userEnteredPrivateKey = Uint8Array.from(Buffer.from(userResponse, 'hex'));
                        
                                // Check if the private key is a Uint8Array with a length of 32 (256 bits)
                                if (userEnteredPrivateKey instanceof Uint8Array && userEnteredPrivateKey.length === 32) {
                                    const wallet = new Wallet(userEnteredPrivateKey);
                                    const walletInfo = {
                                        address: wallet.address,
                                        privateKey: wallet.privateKey
                                    };
                        
                                    await setAsync(`wallets:${username}`, JSON.stringify(walletInfo));
                                    await bot.sendMessage(chatId, `Your wallet has been imported successfully.`);
                                } else {
                                    // Invalid private key format
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
            
                    const response = `═══ Your Wallets ═══\n` +
                        `▰ Wallet ▰\n` +
                        `Bal: ${balanceEther} ETH ($${balanceUsd})\n` +
                        `<a href="address:${walletAddress}">${walletAddress}</a>`;
            
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
                    
                    const gasBuffer = savedGasBufferSettings ? savedGasBufferSettings.gasBuffer + '%' : 'Not set';
                    const slippage = savedSlippageSettings ? savedSlippageSettings.slippage + '%' : 'Not set';
                    
                    const message = `Your current settings:\n\nGas Buffer: ${gasBuffer}\nSlippage: ${slippage}`;
                    const message1 = await bot.sendMessage(chatId, message, { reply_markup: JSON.stringify(settingsKeyboard) });
                    lastMessageId1 = message1.message_id;                } catch (error) {
                    console.error("Error: Retry /start", error);
                    await bot.sendMessage(chatId, "An error occurred while retrieving your settings. Please try again later.");
                }
            }
            
            if (data.startsWith('set_gas_buffer_')) {
                const gasBufferKeyboard = {
                    inline_keyboard: [
                        [{ text: '5%', callback_data: `gas_buffer_5_${username}_${interactionId}` }],
                        [{ text: '10%', callback_data: `gas_buffer_10_${username}_${interactionId}` }],
                        [{ text: '15%', callback_data: `gas_buffer_15_${username}_${interactionId}` }],
                    ]
                };
        
                const message2 = await bot.sendMessage(chatId, 'Select your Gas Buffer:', { reply_markup: JSON.stringify(gasBufferKeyboard) });
                lastMessageId2 = message2.message_id;
            } else if (data.startsWith('set_slippage_')) {
                const slippageKeyboard = {
                    inline_keyboard: [
                        [{ text: '2%', callback_data: `slippage_2_${username}_${interactionId}` }],
                        [{ text: '4%', callback_data: `slippage_4_${username}_${interactionId}` }],
                        [{ text: '6%', callback_data: `slippage_6_${username}_${interactionId}` }],
                        [{ text: 'custom', callback_data: `custom_slippage_${username}_${interactionId}` }],
                    ]
                };
        
                const message2 = await bot.sendMessage(chatId, 'Select your Slippage:', { reply_markup: JSON.stringify(slippageKeyboard) });
                lastMessageId2 = message2.message_id;
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
                        // Check if userResponse is a valid number between 1 and 100
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
                    lastMessageId3 = replyMessage.message_id;
                    console.log(lastMessageId3);
                } catch (error) {
                    console.error('Error retrieving and showing private key:', error);
                    bot.sendMessage(chatId, "An error occurred while retrieving the private key.");
                }
            }
            
            if (data.startsWith('deleteMessage_')) {
            console.log(lastMessageId3);
                if (lastMessageId3) {
                    try {
                        await bot.deleteMessage(chatId, lastMessageId3);
                    } catch (error) {
                        console.error('Error deleting message:', error);
                    }
                }
            }

            if (data.startsWith('gas_buffer_')) {
                const gasBuffer = parseInt(parts[2]);
                await setAsync(`settings:gas_buffer:${username}`, JSON.stringify({ gasBuffer }));
                await bot.sendMessage(chatId, `Gas Buffer set to ${gasBuffer}%`);
                if (lastMessageId1!= null) {
                    await bot.deleteMessage(chatId, lastMessageId1);
                }
                if (lastMessageId2!= null) {
                    await bot.deleteMessage(chatId, lastMessageId2);
                }
        
            } else if (data.startsWith('slippage_')) {
                const slippage = parseInt(parts[1]);
                await setAsync(`settings:slippage:${username}`, JSON.stringify({ slippage }));
                await bot.sendMessage(chatId, `Slippage set to ${slippage}%`);
                console.log(lastMessageId1);
                console.log(lastMessageId2);
                if (lastMessageId1!= null) {
                    await bot.deleteMessage(chatId, lastMessageId1);
                }
                if (lastMessageId2!= null) {
                    await bot.deleteMessage(chatId, lastMessageId2);
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
