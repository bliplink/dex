// 1. 导入 express 模块
const express = require('express');
const { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage, AddressLookupTableAccount, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const { getMint, amountToUiAmount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createCloseAccountInstruction, createSyncNativeInstruction, NATIVE_MINT } = require('@solana/spl-token');
const { Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');

const bs58 = require('bs58');

const { Wallet, AnchorProvider, Program, BorshCoder, BN, web3 } = require("@coral-xyz/anchor");
const axios = require('axios');

// Jupiter API 相关函数
async function getJupiterSwapQuote(inputMint, outputMint, amount, slippageBps = 50) {
    try {
        const response = await axios.get(`https://lite-api.jup.ag/swap/v1/quote`, {
            params: {
                inputMint: inputMint,
                outputMint: outputMint,
                amount: amount,
                slippageBps: slippageBps
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error getting Jupiter quote:', error);
        throw error;
    }
}

async function getJupiterSwapTransaction(quoteResponse, userPublicKey) {
    try {
        const response = await axios.post('https://lite-api.jup.ag/swap/v1/swap', {
            quoteResponse,
            userPublicKey: userPublicKey,
            wrapAndUnwrapSol: true
        });
        return response.data;
    } catch (error) {
        console.error('Error getting Jupiter swap transaction:', error);
        throw error;
    }
}

// 2. 创建 Express 应用实例
const app = express();

// 3. 定义端口号，优先使用环境变量指定的端口，否则默认为 3000
const port = process.env.PORT || 3000;

// 解析 application/json 格式的请求体
app.use(express.json());

// 解析 application/x-www-form-urlencoded 格式的请求体
app.use(express.urlencoded({ extended: true }));

// 4. 定义一个路由，处理对根路径 (GET /) 的请求
// 4. 定义 Jupiter 交换接口，支持 POST 请求[7,8](@ref)
app.post('/jupswap', async (req, res) => {
    try {
        // 5. 从请求体中获取参数[6,7](@ref)
        const { 
            inputMint, 
            inputAmount, 
            outputMint, 
            rpcUrl, 
            signer 
        } = req.body;

        // 6. 参数验证[2](@ref)
        if (!inputMint || !inputAmount || !outputMint || !rpcUrl || !signer) {
            return res.status(400).json({
                error: 'Missing required parameters',
                required: ['inputMint', 'inputAmount', 'outputMint', 'rpcUrl', 'signer']
            });
        }

        // 验证输入金额为有效数字
        const amount = Number(inputAmount);
        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({
                error: 'Invalid inputAmount: must be a positive number'
            });
        }

        // 解码签名者私钥
        let signerKeypair;
        try {
            const signerSecretKey = bs58.default.decode(signer);
            signerKeypair = Keypair.fromSecretKey(signerSecretKey);
        } catch (error) {
            return res.status(400).json({
                error: 'Invalid signer private key format'
            });
        }

        // 创建 Solana 连接
        const connection = new Connection(rpcUrl, 'confirmed');

        // 7. 获取 Jupiter 报价[9](@ref)
        const quote = await getJupiterSwapQuote(
            inputMint,
            outputMint,
            amount,
            100 // 1% slippage
        );

        console.log(`Quote obtained: priceImpact=${quote.priceImpactPct}, outAmount=${quote.outAmount}`);

        // 8. 获取交换交易[9](@ref)
        const swapResponse = await getJupiterSwapTransaction(quote, signerKeypair.publicKey.toString());

        // 反序列化交易
        const swapTransaction = VersionedTransaction.deserialize(
            Buffer.from(swapResponse.swapTransaction, 'base64')
        );

        // 签名交易
        swapTransaction.sign([signerKeypair]);

        // 发送交易
        const swapSignature = await connection.sendTransaction(swapTransaction);
        
        // 等待交易确认
        await connection.confirmTransaction(swapSignature, 'processed');

        console.log(`Jupiter swap transaction successful: ${swapSignature}`);

        // 9. 返回结果[8](@ref)
        res.json({
            success: true,
            swapSignature: swapSignature,
            outAmount: quote.outAmount,
            inputAmount: amount,
            inputMint: inputMint,
            outputMint: outputMint,
            priceImpactPct: quote.priceImpactPct
        });

    } catch (error) {
        console.error('Error in Jupiter swap:', error);
        
        // 10. 错误处理[8](@ref)
        res.status(500).json({
            success: false,
            error: error.message,
            swapSignature: null,
            outAmount: null
        });
    }
});

// 11. 添加 GET 接口用于测试和基本信息获取[6](@ref)
app.get('/jupswap', (req, res) => {
    res.json({
        message: 'Jupiter Swap API is running',
        usage: 'Send POST request with parameters: inputMint, inputAmount, outputMint, rpcUrl, signer',
        example: {
            inputMint: "So11111111111111111111111111111111111111112",
            inputAmount: "100",
            outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            rpcUrl: "https://mainnet.helius-rpc.com/?api-key=3c947f86-9063-4c0b-9ae1-4c6882fba344",
            signer: "your-private-key-in-bs58-format"
        }
    });
});
// 12. 添加健康检查端点[8](@ref)
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// 5. 启动服务器，开始监听指定端口
app.listen(port, () => {
    console.log(`Express服务器正在运行 http://localhost:${port}`);
});