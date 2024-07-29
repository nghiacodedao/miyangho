const ccxt = require('ccxt');
const moment = require('moment');
const { EMA, RSI } = require('technicalindicators');
require('dotenv').config();
const fs = require('fs');
const colors = require('colors');
const Table = require('cli-table3');

const ACCOUNT_BALANCE = 6.9; // Thay bằng số dư thực tế của tài khoản của bạn
const MARGIN_PER_TRADE = 0.1; // 10% tài khoản cho mỗi lệnh
const STOP_LOSS_PERCENTAGE = 0.1; 
const TAKE_PROFIT_PERCENTAGE = 0.2; 
const GLOBAL_STOP_LOSS = 0.1; // Dừng bot nếu thua lỗ 10% tài khoản

const TRADING_PAIRS = ['ETH/USDT', 'BTC/USDT'];

let currentPositions = {};
let openOrders = {};
let stopBot = false;

const bitget = new ccxt.bitget({
    apiKey: '',
    secret: '',
    password: '',
    enableRateLimit: true,
    options: {
        defaultType: 'swap',
        createMarketBuyOrderRequiresPrice: false
    }
});

function log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    let coloredMessage;
    switch (type) {
        case 'error':
            coloredMessage = message.red;
            break;
        case 'success':
            coloredMessage = message.green;
            break;
        case 'warning':
            coloredMessage = message.yellow;
            break;
        default:
            coloredMessage = message.blue;
    }
    const logMessage = `${timestamp.gray}: ${coloredMessage}`;
    console.log(logMessage);
    fs.appendFileSync('trading_log.txt', `${timestamp}: ${message}\n`);
}

function displayTradingInfo(symbol, prices, indicators) {
    const table = new Table({
        head: [
            'Timestamp'.cyan,
            'Price'.cyan,
            'EMA34'.cyan,
            'EMA50'.cyan,
            'RSI14'.cyan
        ],
        colWidths: [25, 15, 15, 15, 15]
    });

    const lastIndex = prices.length - 1;
    const lastPrice = prices[lastIndex];
    const lastIndicators = {
        ema34: indicators.ema34[indicators.ema34.length - 1],
        ema50: indicators.ema50[indicators.ema50.length - 1],
        rsi14: indicators.rsi14[indicators.rsi14.length - 1]
    };

    table.push([
        lastPrice.timestamp,
        lastPrice.close.toFixed(2),
        lastIndicators.ema34.toFixed(2),
        lastIndicators.ema50.toFixed(2),
        lastIndicators.rsi14.toFixed(2)
    ]);

    console.log(`\nTrading Info for ${symbol}:`.yellow);
    console.log(table.toString());
}

async function fetchPrices(symbol) {
    const prices = await bitget.fetchOHLCV(symbol, '15m');
    return prices.map(price => ({
        timestamp: moment(price[0]).format(),
        open: price[1],
        high: price[2],
        low: price[3],
        close: price[4],
        volume: price[5]
    }));
}

function calculateIndicators(prices) {
    const closingPrices = prices.map(p => p.close);
    return {
        ema34: EMA.calculate({ period: 34, values: closingPrices }),
        ema50: EMA.calculate({ period: 50, values: closingPrices }),
        ema150: EMA.calculate({ period: 150, values: closingPrices }),
        ema200: EMA.calculate({ period: 200, values: closingPrices }),
        rsi14: RSI.calculate({ period: 14, values: closingPrices })
    };
}

function addIndicators(prices, indicators) {
    return prices.map((price, index) => ({
        ...price,
        ema34: index >= 33 ? indicators.ema34[index - 33] : null,
        ema50: index >= 49 ? indicators.ema50[index - 49] : null,
        ema150: index >= 149 ? indicators.ema150[index - 149] : null,
        ema200: index >= 199 ? indicators.ema200[index - 199] : null,
        rsi14: index >= 13 ? indicators.rsi14[index - 13] : null
    }));
}

async function placeOrder(symbol, side, amount) {
    try {
        const balance = await bitget.fetchBalance();
        const availableBalance = balance.USDT.free;
        if (availableBalance < ACCOUNT_BALANCE * MARGIN_PER_TRADE) {
            log(`Insufficient balance to place order. Need ${ACCOUNT_BALANCE * MARGIN_PER_TRADE} USDT, have ${availableBalance} USDT`, 'warning');
            return;
        }

        let order;
        if (side === 'buy') {
            // Đối với lệnh mua, chúng ta sẽ sử dụng số tiền USDT làm amount
            order = await bitget.createMarketBuyOrder(symbol, amount * ACCOUNT_BALANCE * MARGIN_PER_TRADE);
        } else {
            // Đối với lệnh bán, chúng ta sử dụng số lượng coin
            order = await bitget.createMarketSellOrder(symbol, amount);
        }
        log(`Placed market order: ${side} ${amount} ${symbol}`, 'success');

        const { price: entryPrice } = await bitget.fetchTicker(symbol);
        const stopLossPrice = side === 'buy' ? entryPrice * (1 - STOP_LOSS_PERCENTAGE) : entryPrice * (1 + STOP_LOSS_PERCENTAGE);
        const takeProfitPrice = side === 'buy' ? entryPrice * (1 + TAKE_PROFIT_PERCENTAGE) : entryPrice * (1 - TAKE_PROFIT_PERCENTAGE);

        await Promise.all([
            bitget.createOrder(symbol, 'stop', side === 'buy' ? 'sell' : 'buy', order.amount, stopLossPrice, { stopPrice: stopLossPrice }),
            bitget.createOrder(symbol, 'take_profit', side === 'buy' ? 'sell' : 'buy', order.amount, takeProfitPrice, { stopPrice: takeProfitPrice })
        ]);

        log(`Set Stop Loss at ${stopLossPrice} and Take Profit at ${takeProfitPrice}`, 'info');
        openOrders[symbol] = { side, amount: order.amount, entryPrice, stopLossPrice, takeProfitPrice };
    } catch (error) {
        log(`Unable to place ${side} order for ${symbol}: ${error.message}`, 'error');
    }
}

async function closePosition(symbol) {
    try {
        const position = currentPositions[symbol];
        if (position) {
            const closeOrder = await bitget.createMarketOrder(symbol, position.side === 'buy' ? 'sell' : 'buy', position.amount);
            log(`Closed position: ${position.side} ${position.amount} ${symbol}`, 'success');

            currentPositions[symbol] = null;
            openOrders[symbol] = null;
        }
    } catch (error) {
        log(`Unable to close position for ${symbol}: ${error.message}`, 'error');
    }
}

async function manageOpenOrders(symbol) {
    try {
        const orders = await bitget.fetchOpenOrders(symbol);
        for (const order of orders) {
            const { price, side, id } = order;
            if (openOrders[symbol] && ((side === 'buy' && (price <= openOrders[symbol].stopLossPrice || price >= openOrders[symbol].takeProfitPrice)) ||
                (side === 'sell' && (price >= openOrders[symbol].stopLossPrice || price <= openOrders[symbol].takeProfitPrice)))) {
                log(`Order ${side} triggered at ${price} for ${symbol}`, 'warning');
                await bitget.cancelOrder(id, symbol);
                log(`Order ${side} cancelled at ${price} for ${symbol}`, 'info');
                await closePosition(symbol);
            }
        }
    } catch (error) {
        log(`Unable to manage open orders for ${symbol}: ${error.message}`, 'error');
    }
}

function isBullishEngulfing(prev, curr) {
    return prev.close < prev.open && curr.close > curr.open && curr.close > prev.open && curr.open < prev.close;
}

function isBearishEngulfing(prev, curr) {
    return prev.close > prev.open && curr.close < curr.open && curr.close < prev.open && curr.open > prev.close;
}

async function analyzePair(symbol) {
    try {
        log(`Analyzing ${symbol}...`, 'info');
        const prices = await fetchPrices(symbol);
        log(`Fetched ${prices.length} price points for ${symbol}`, 'success');

        const indicators = calculateIndicators(prices);
        log(`Calculated indicators for ${symbol}`, 'success');

        const pricesWithIndicators = addIndicators(prices, indicators);

        displayTradingInfo(symbol, prices, indicators);

        for (let i = 1; i < pricesWithIndicators.length; i++) {
            const prev = pricesWithIndicators[i - 1];
            const curr = pricesWithIndicators[i];
            const tradeMargin = ACCOUNT_BALANCE * MARGIN_PER_TRADE;
            const amountToTrade = curr.close; // We'll use this for sell orders

            log(`Analyzing candle ${i}: ${curr.timestamp} for ${symbol}`, 'info');

            if (!currentPositions[symbol]) {
                if (isBullishEngulfing(prev, curr) && curr.close > curr.ema34 && curr.rsi14 < 70) {
                    log(`BUY signal at ${curr.timestamp} for ${symbol}`, 'success');
                    await placeOrder(symbol, 'buy', 1); // 1 here because we calculate the USDT amount in placeOrder
                    currentPositions[symbol] = { side: 'buy', amount: tradeMargin / curr.close, entryPrice: curr.close };
                } else if (isBearishEngulfing(prev, curr) && curr.close < curr.ema34 && curr.rsi14 > 30) {
                    log(`SELL signal at ${curr.timestamp} for ${symbol}`, 'success');
                    await placeOrder(symbol, 'sell', amountToTrade);
                    currentPositions[symbol] = { side: 'sell', amount: amountToTrade, entryPrice: curr.close };
                }

                if (curr.ema50 && prev.ema50) {
                    if (prev.ema50 < prev.close && curr.ema50 > curr.close && curr.rsi14 < 70) {
                        log(`BUY signal at ${curr.timestamp} (EMA50 Cross) for ${symbol}`, 'success');
                        await placeOrder(symbol, 'buy', 1); // 1 here because we calculate the USDT amount in placeOrder
                        currentPositions[symbol] = { side: 'buy', amount: tradeMargin / curr.close, entryPrice: curr.close };
                    } else if (prev.ema50 > prev.close && curr.ema50 < curr.close && curr.rsi14 > 30) {
                        log(`SELL signal at ${curr.timestamp} (EMA50 Cross) for ${symbol}`, 'success');
                        await placeOrder(symbol, 'sell', amountToTrade);
                        currentPositions[symbol] = { side: 'sell', amount: amountToTrade, entryPrice: curr.close };
                    }
                }
            }
        }

        if (openOrders[symbol]) {
            log(`Managing open orders for ${symbol}...`, 'info');
            await manageOpenOrders(symbol);
        }
    } catch (error) {
        log(`Error in analyzePair for ${symbol}: ${error.message}`, 'error');
    }
}

async function checkGlobalStopLoss() {
    const balance = await bitget.fetchBalance();
    const currentBalance = balance.USDT.total;
    if (currentBalance < ACCOUNT_BALANCE * (1 - GLOBAL_STOP_LOSS)) {
        log(`Global stop loss reached. Stopping bot.`, 'warning');
        stopBot = true;
    }
}

async function main() {
    for (const symbol of TRADING_PAIRS) {
        await checkGlobalStopLoss();
        if (stopBot) break;
        await analyzePair(symbol);
    }
}

async function checkAccountBalance() {
    try {
        const balance = await bitget.fetchBalance();
        log('Account balance: ' + JSON.stringify(balance.total), 'info');
    } catch (error) {
        log('Error fetching account balance: ' + error.message, 'error');
    }
}

async function runBot() {
    while (!stopBot) {
        await main();
        await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 1 minute before running again
    }
}

const readline = require('readline');
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.on('line', (input) => {
    if (input.trim().toLowerCase() === 'stop') {
        log('Received user command. Stopping bot...', 'warning');
        stopBot = true;
    } else if (input.trim().toLowerCase() === 'start') {
        log('Received user command. Starting bot...', 'success');
        if (stopBot) {
            stopBot = true;
            runBot();
        }
    }
});

log('Starting bot on real account...', 'info');
checkAccountBalance().then(() => {
    runBot();
});