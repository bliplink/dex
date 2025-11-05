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
const port = process.env.PORT || 30000;

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


 /**
 * 获取钱包所有 Token 余额的接口 - 集成 Jupiter v2/search API
 */
app.get('/wallet-tokens', async (req, res) => {
    try {
        const { 
            address, 
            rpcUrl = 'https://api.mainnet-beta.solana.com',
            includeLogo = 'true',
            includeTags = 'true'
        } = req.query;

        // 参数验证
        if (!address) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameter: address',
                example: '/wallet-tokens?address=YOUR_WALLET_ADDRESS&rpcUrl=OPTIONAL_RPC_URL'
            });
        }

        // 验证钱包地址格式
        try {
            new PublicKey(address);
        } catch (error) {
            return res.status(400).json({
                success: false,
                error: 'Invalid Solana wallet address format'
            });
        }

        console.log(`查询钱包余额: ${address}, 使用 RPC: ${rpcUrl}`);

        // 创建 Solana 连接
        const connection = new Connection(rpcUrl, 'confirmed');
        const publicKey = new PublicKey(address);

        // 1. 获取主网 SOL 余额
        const solBalance = await connection.getBalance(publicKey);
        const solBalanceInSOL = solBalance / LAMPORTS_PER_SOL;

        // 2. 获取所有 SPL Token 账户
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
            publicKey,
            { programId: TOKEN_PROGRAM_ID }
        );

        // 3. 提取所有代币 mint 地址用于批量查询元数据
        const mintAddresses = [];
        const tokenAccountMap = new Map(); // 用于快速查找账户信息
        
        tokenAccounts.value.forEach(account => {
            const accountData = account.account.data.parsed.info;
            const tokenAmount = accountData.tokenAmount;
            
            if (tokenAmount.uiAmount > 0) {
                mintAddresses.push(accountData.mint);
                tokenAccountMap.set(accountData.mint, {
                    accountInfo: accountData,
                    pubkey: account.pubkey.toString()
                });
            }
        });

        // 4. 批量获取代币元数据 [1](@ref)
        let tokenMetadata = [];
        if (mintAddresses.length > 0) {
            tokenMetadata = await getTokenMetadataFromJupiterV2({
                query: mintAddresses.join(','),
                exactMatch: true,
                limit: mintAddresses.length
            });
        }

        // 5. 构建代币信息映射表
        const tokenInfoMap = new Map();
        tokenMetadata.forEach(token => {
            tokenInfoMap.set(token.address, {
                symbol: token.symbol,
                name: token.name,
                logoURI: token.logoURI,
                tags: token.tags || [],
                verified: true,
                source: 'jupiter-v2',
                usdPrice:token.usdPrice
            });
        });

        // 6. 处理 Token 数据
        const tokens = [];
        
        // 添加 SOL 余额
        if (solBalanceInSOL > 0) {
            tokens.push({
                mint: NATIVE_MINT.toBase58(),
                symbol: 'SOL',
                name: 'Solana',
                balance: solBalance,
                decimals: 9,
                uiAmount: solBalanceInSOL,
                isNative: true,
                tokenAccount: publicKey.toString(),
                logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
                verified: true,
                source: 'native'
            });
        }

        // 7. 处理 SPL Tokens
        tokenAccounts.value.forEach(account => {
            const accountData = account.account.data.parsed.info;
            const tokenAmount = accountData.tokenAmount;
            
            if (tokenAmount.uiAmount > 0) {
                try {
                    // 从 Jupiter API 获取代币元数据 [1](@ref)
                    const jupiterTokenInfo = tokenInfoMap.get(accountData.mint);
                    
                    let tokenInfo;
                    if (jupiterTokenInfo) {
                        // 使用 Jupiter 返回的准确信息
                        tokenInfo = {
                            symbol: jupiterTokenInfo.symbol,
                            name: jupiterTokenInfo.name,
                            logoURI: jupiterTokenInfo.logoURI,
                            tags: jupiterTokenInfo.tags,
                            verified: true,
                            source: 'jupiter-v2',
                            usdPrice:jupiterTokenInfo.usdPrice
                        };
                    }  
                    const tokenData = {
                        mint: accountData.mint,
                        symbol: tokenInfo.symbol,
                        name: tokenInfo.name,
                        balance: Number(tokenAmount.amount),
                        decimals: tokenAmount.decimals,
                        uiAmount: tokenAmount.uiAmount,
                        isNative: false,
                        tokenAccount: account.pubkey.toString(),
                        verified: tokenInfo.verified,
                        source: tokenInfo.source,
                        usdPrice:tokenInfo.usdPrice
                    };

                    // 根据参数决定是否包含可选字段
                    if (includeLogo === 'true' && tokenInfo.logoURI) {
                        tokenData.logoURI = tokenInfo.logoURI;
                    }
                    
                    if (includeTags === 'true' && tokenInfo.tags) {
                        tokenData.tags = tokenInfo.tags;
                    }
                    if(tokenData.usdPrice){
                    tokens.push(tokenData);
                    }
                } catch (error) {
                    console.error(`处理代币账户 ${account.pubkey.toString()} 时出错:`, error);
                    
                    // 即使元数据获取失败，也返回基础余额信息
                    tokens.push({
                        mint: accountData.mint,
                        symbol: 'UNKNOWN',
                        name: 'Unknown Token',
                        balance: Number(tokenAmount.amount),
                        decimals: tokenAmount.decimals,
                        uiAmount: tokenAmount.uiAmount,
                        isNative: false,
                        tokenAccount: account.pubkey.toString(),
                        verified: false,
                        source: 'fallback',
                        error: 'Metadata fetch failed'
                    });
                }
            }
        });

        // 8. 返回结果
        res.json({
            success: true,
            wallet: address,
            rpcUrl: rpcUrl,
            totalTokens: tokens.length,
            tokens: tokens,
            summary: {         
                solBalance: solBalanceInSOL,
                splTokensCount: tokens.filter(t => !t.isNative).length,
                verifiedTokensCount: tokens.filter(t => t.verified).length,
                unverifiedTokensCount: tokens.filter(t => !t.verified).length
            },
            metadata: {
                source: 'Jupiter v2/search API + Solana RPC',
                totalMintsQueried: mintAddresses.length,
                successfulMetadataQueries: tokenMetadata.length,
                queryTime: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Error fetching wallet tokens:', error);
        
        res.status(500).json({
            success: false,
            error: error.message,
            wallet: req.query.address || 'unknown',
            suggestion: '请检查钱包地址格式和RPC连接状态'
        });
    }
});

/**
 * 获取代币元数据的 GET 接口
 * 通过 Jupiter v2/search API 查询代币信息
 */
app.get('/token-metadata', async (req, res) => {
    try {
        const { 
            query,          // 支持代币地址、符号或名称查询
            rpcUrl,         // 保留参数，虽然本接口不使用
            exactMatch = 'false', // 是否精确匹配
            limit = '50'    // 返回结果数量限制
        } = req.query;

        // 参数验证
        if (!query) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameter: query',
                example: '/token-metadata?query=USDC',
                description: '可传入代币地址、符号或名称进行搜索'
            });
        }

        console.log(`查询代币元数据: ${query}`);

        // 调用 Jupiter API 获取代币元数据
        const tokenMetadata = await getTokenMetadataFromJupiterV2({
            query,
            exactMatch: exactMatch === 'true',
            limit: parseInt(limit)
        });
        
        // 返回成功响应
        res.json({
            success: true,
            metadata: {
                source: 'Jupiter v2/search API',
                query: query,
                exactMatch: exactMatch === 'true',
                limit: parseInt(limit),
                found: tokenMetadata.length,
                queryTime: new Date().toISOString()
            },
            tokens: tokenMetadata
        });

    } catch (error) {
        console.error('Error in token-metadata endpoint:', error);
        
        res.status(500).json({
            success: false,
            error: error.message,
            query: req.query.query || 'unknown',
            suggestion: '请检查查询参数或稍后重试'
        });
    }
});

/**
 * 使用 Jupiter v2/search API 获取代币元数据
 * @param {Object} params 
 * @param {string} params.query 查询字符串（地址/符号/名称）
 * @param {boolean} [params.exactMatch] 是否精确匹配
 * @param {number} [params.limit=50] 返回结果数量限制
 */
async function getTokenMetadataFromJupiterV2({ query, exactMatch = false, limit = 50 }) {
    try {
        const response = await axios.get(
            'https://lite-api.jup.ag/tokens/v2/search', 
            {
                params: {
                    query: query,
                    exactMatch: exactMatch,
                    limit: limit
                },
                timeout: 10000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'TokenMetadataAPI/1.0'
                }
            }
        );
        
        // 处理返回数据
        return (response.data || []).map(token => ({
            address: token.id, 
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            logoURI: token.icon,          
            usdPrice:token.usdPrice,
            verified: true
            
        }));
    } catch (error) {
        console.error('Jupiter API 错误:', {
            url: error.config?.url,
            status: error.response?.status,
            data: error.response?.data
        });
        
        throw new Error(`Jupiter API 请求失败: ${error.message}`);
    }
}
// 5. 启动服务器，开始监听指定端口
app.listen(port, () => {
    console.log(`Express服务器正在运行 http://localhost:${port}`);
});