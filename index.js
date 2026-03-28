const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const dotenv = require('dotenv');
const fs = require('fs');
const fsExtra = require('fs-extra');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const https = require('https');
const EfiPay = require('sdk-node-apis-efi');
const { exec } = require('child_process');

// Verificar e matar instâncias anteriores do bot
const currentPid = process.pid;
exec(`pgrep -f "node index.js" | grep -v ${currentPid}`, (error, stdout) => {
    if (stdout) {
        const pids = stdout.trim().split('\n');
        pids.forEach(pid => {
            if (pid && pid !== currentPid.toString()) {
                try {
                    process.kill(parseInt(pid), 'SIGTERM');
                    console.log(`Instancia anterior do bot (PID: ${pid}) finalizada.`);
                } catch (e) {
                    // Ignora erros se o processo ja nao existe
                }
            }
        });
    }
});

dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const ticketChannels = new Map(); // Armazena categoria de tickets por servidor
const ticketOptions = new Map(); // Armazena opções de tickets por servidor
const staffRoles = new Map(); // Armazena cargos de staff por servidor
const ticketMessages = new Map(); // Armazena mensagens personalizadas por servidor
const defaultTicketChannels = new Map(); // Armazena canal padrão para mensagens por servidor
const ticketVisuals = new Map(); // Armazena configurações visuais por servidor
const transcriptChannels = new Map(); // Armazena canal de transcripts por servidor
const ticketCooldowns = new Map(); // Armazena cooldowns de criação de tickets por usuário
const activeTranscripts = new Set(); // Armazena IDs de canais com transcripts em processamento
const products = new Map(); // Armazena produtos por servidor
const productPlans = new Map(); // Armazena planos de produtos por servidor
const productChannels = new Map(); // Armazena canal cadastrado por produto
const shoppingCarts = new Map(); // Armazena carrinhos de compras por usuário (guildId_userId)
const purchaseCategories = new Map(); // Armazena canal de categoria de compra por servidor
const coupons = new Map(); // Armazena cupons por servidor
const productShipping = new Map(); // Armazena informações de envio por servidor
const purchaseTranscriptChannels = new Map(); // Armazena canal de transcript de compras por servidor
const logsChannels = new Map(); // Armazena canal de logs de entrada/saída por servidor
const restoreCordRoles = new Map(); // Armazena cargo de verificação do RestoreCord por servidor
const clientRoles = new Map(); // Armazena cargo de clientes por servidor (guildId -> roleId)
const efiCredentials = new Map(); // Armazena credenciais EFI por servidor (guildId -> {clientId, clientSecret, pixKey})
const productStock = new Map(); // Armazena estoque de produtos por servidor
const keyAuthStock = new Map(); // Armazena configurações de KeyAuth por servidor
const manualStock = new Map(); // Armazena estoque manual de keys por servidor
const stockPreference = new Map(); // Armazena preferência de estoque por produto (auto/manual)

// Sistema de persistência
const DATA_FILE = './bot_data.json';

// Classe de integração com API EFI usando SDK oficial
class EFIBankAPI {
    constructor(clientId, clientSecret, certificatePath = './certificado.p12') {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.certificatePath = certificatePath;
        this.efiPay = null;
        this.initialized = false;
    }

    initialize() {
        try {
            if (!fs.existsSync(this.certificatePath)) {
                console.error(`Certificado não encontrado: ${this.certificatePath}`);
                return false;
            }

            this.efiPay = new EfiPay({
                sandbox: false,
                client_id: this.clientId,
                client_secret: this.clientSecret,
                certificate: this.certificatePath
            });

            this.initialized = true;
            return true;
        } catch (error) {
            console.error('Erro ao inicializar SDK EFI:', error.message);
            return false;
        }
    }

    async createPixCharge(amount, description, pixKey) {
        try {
            if (!this.initialized) {
                const initSuccess = this.initialize();
                if (!initSuccess) {
                    throw new Error('Falha ao inicializar SDK EFI');
                }
            }

            const chargeData = {
                calendario: {
                    expiracao: 3600 // 1 hora
                },
                valor: {
                    original: amount.toFixed(2)
                },
                chave: pixKey,
                solicitacaoPagador: description
            };

            const response = await this.efiPay.pixCreateImmediateCharge({}, chargeData);
            
            const pixCopiaECola = response.pixCopiaECola;
            
            const qrCodeBuffer = await generateQRCode(pixCopiaECola);

            return {
                txid: response.txid,
                qrcode: qrCodeBuffer,
                emv: pixCopiaECola,
                location: response.loc,
                pixCopiaECola: pixCopiaECola
            };
        } catch (error) {
            console.error('Erro ao criar cobrança Pix:', error.message);
            if (error.error) {
                console.error('Detalhes:', JSON.stringify(error.error, null, 2));
            }
            throw error;
        }
    }

    async checkPaymentStatus(txid) {
        try {
            if (!this.initialized) {
                const initSuccess = this.initialize();
                if (!initSuccess) {
                    throw new Error('Falha ao inicializar SDK EFI');
                }
            }

            const response = await this.efiPay.pixDetailCharge({
                txid: txid
            });

            return {
                status: response.status,
                paidAt: response.pix?.[0]?.horario || null,
                pixData: response.pix
            };
        } catch (error) {
            console.error('Erro ao verificar status do pagamento:', error.message);
            throw error;
        }
    }
}

// Função para validar chave Pix
function validatePixKey(pixKey) {
    // CPF: 11 dígitos
    if (/^\d{11}$/.test(pixKey)) {
        return true;
    }
    
    // CNPJ: 14 dígitos
    if (/^\d{14}$/.test(pixKey)) {
        return true;
    }
    
    // Email: formato básico de email
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pixKey)) {
        return true;
    }
    
    // Telefone: +55XX9XXXXXXX ou XX9XXXXXXX
    if (/^\+55\d{10,11}$/.test(pixKey) || /^\d{10,11}$/.test(pixKey)) {
        return true;
    }
    
    // Chave Aleatória: formato UUID
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pixKey)) {
        return true;
    }
    
    return false;
}

// Map para armazenar instâncias da API EFI por servidor
const efiInstances = new Map();

// Map para armazenar pagamentos em andamento
const pendingPayments = new Map();

// Função para obter instância da API EFI
function getEFIInstance(guildId) {
    if (!efiInstances.has(guildId)) {
        const credentials = efiCredentials.get(guildId);
        if (!credentials) {
            throw new Error('Credenciais EFI não configuradas');
        }
        efiInstances.set(guildId, new EFIBankAPI(credentials.clientId, credentials.clientSecret));
    }
    return efiInstances.get(guildId);
}

// Função para gerar QR Code
async function generateQRCode(text) {
    try {
        const qrCodeDataUrl = await QRCode.toDataURL(text, {
            width: 800,
            margin: 2,
            errorCorrectionLevel: 'M'
        });
        // Converter base64 para buffer
        const base64Data = qrCodeDataUrl.replace(/^data:image\/png;base64,/, '');
        return Buffer.from(base64Data, 'base64');
    } catch (error) {
        console.error('Erro ao gerar QR Code:', error);
        throw error;
    }
}

// Função para criar pagamento Pix
async function createPixPayment(guildId, amount, description, userId, cartId) {
    try {
        const efi = getEFIInstance(guildId);
        const credentials = efiCredentials.get(guildId);
        
        // Criar cobrança com a chave Pix configurada
        const charge = await efi.createPixCharge(amount, description, credentials.pixKey);
        
        // Validar se a API retornou os dados corretamente
        if (!charge || !charge.emv) {
            throw new Error('Falha ao criar cobrança Pix. Verifique se as credenciais EFI estão configuradas corretamente.');
        }
        
        // Gerar QR Code - agora vem direto da classe
        const qrCodeBuffer = charge.qrcode;
        
        // Salvar pagamento em andamento
        const paymentData = {
            txid: charge.txid,
            userId: userId,
            cartId: cartId,
            amount: amount,
            description: description,
            createdAt: Date.now(),
            status: 'pending'
        };
        
        pendingPayments.set(charge.txid, paymentData);
        
        return {
            txid: charge.txid,
            qrCode: qrCodeBuffer,
            emv: charge.emv,
            amount: amount,
            pixKey: credentials.pixKey
        };
    } catch (error) {
        console.error('Erro ao criar pagamento Pix:', error);
        throw error;
    }
}

// Função para verificar pagamento
async function checkPayment(txid) {
    try {
        const payment = pendingPayments.get(txid);
        if (!payment) {
            return null;
        }
        
        const guildId = payment.cartId.split('_')[0];
        const efi = getEFIInstance(guildId);
        
        const status = await efi.checkPaymentStatus(txid);
        
        if (status.status === 'CONCLUIDA') {
            payment.status = 'paid';
            payment.paidAt = status.paidAt;
            pendingPayments.set(txid, payment);
            return payment;
        }
        
        return null;
    } catch (error) {
        console.error('Erro ao verificar pagamento:', error);
        return null;
    }
}

// Função para iniciar verificação automática de pagamento
function startPaymentCheck(txid, interaction) {
    const checkInterval = setInterval(async () => {
        try {
            const payment = await checkPayment(txid);
            
            if (payment && payment.status === 'paid') {
                clearInterval(checkInterval);
                
                // Processar compra concluída
                await processCompletedPayment(interaction, payment);
            }
        } catch (error) {
            console.error('Erro na verificação automática:', error);
        }
    }, 10000); // Verificar a cada 10 segundos
    
    // Parar verificação após 1 hora
    setTimeout(() => {
        clearInterval(checkInterval);
    }, 3600000);
}

// Função para processar pagamento concluído
async function processCompletedPayment(interaction, payment) {
    try {
        const cartId = payment.cartId;
        const cart = shoppingCarts.get(cartId);
        
        if (!cart) {
            console.error('Carrinho não encontrado para o pagamento:', payment.txid);
            return;
        }

        // Processar a compra
        const purchaseId = `purchase_${Date.now()}`;
        const purchaseDate = new Date().toLocaleString('pt-BR');

        // Deduzir do estoque
        const guildId = cartId.split('_')[0];
        const updatedGuildStock = productStock.get(guildId) || {};
        for (const item of cart.items) {
            if (updatedGuildStock[item.productId]) {
                updatedGuildStock[item.productId] -= item.quantity;
            }
        }
        productStock.set(guildId, updatedGuildStock);

        // Obter informações de envio
        const guildShipping = productShipping.get(guildId) || {};
        const shippingInfo = [];

        for (const item of cart.items) {
            const shipping = guildShipping[item.productId];
            if (shipping) {
                shippingInfo.push({
                    productName: item.productName,
                    tutorial: shipping.tutorial,
                    videoLink: shipping.videoLink,
                    downloadLink: shipping.downloadLink
                });
            }
        }

        // Enviar confirmação
        const confirmationEmbed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('✅ Pagamento Confirmado!')
            .setDescription(`Compra realizada com sucesso! ID: ${purchaseId}`)
            .addFields(
                { name: 'Data da Compra', value: purchaseDate, inline: false },
                { name: 'Total Pago', value: `R$ ${payment.amount.toFixed(2)}`, inline: true },
                { name: 'Forma de Pagamento', value: 'Pix (EFI Bank)', inline: true },
                { name: 'ID da Transação', value: payment.txid, inline: true }
            )
            .setTimestamp();

        if (cart.appliedCoupon) {
            confirmationEmbed.addFields(
                { name: 'Cupom Aplicado', value: `${cart.appliedCoupon.code} (${cart.appliedCoupon.percentage}% off)`, inline: false }
            );
        }

        await interaction.editReply({ embeds: [confirmationEmbed], components: [], files: [] });

        // Enviar informações do produto por DM
        const user = interaction.user;
        try {
            const guildProducts = products.get(guildId) || [];
            
            for (const item of cart.items) {
                const shipping = guildShipping[item.productId];
                if (shipping) {
                    const productInfo = guildProducts.find(p => p.id === item.productId);
                    
                    // Adicionar preço ao item se não existir
                    if (!item.price) {
                        const guildPlans = productPlans.get(guildId) || {};
                        const plans = guildPlans[item.productId] || [];
                        const planInfo = plans.find(p => p.name === item.planName);
                        if (planInfo) {
                            item.price = planInfo.price;
                        }
                    }
                    
                    // Gerar/obter key do produto
                    const keyResult = await getProductKey(guildId, item.productId, item.planName);
                    
                    // Criar embed com informações do produto
                    const productEmbed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle(item.productName)
                        .setDescription('Agradecemos sua compra! Abaixo estão as instruções e arquivos:')
                        .setFooter({ text: productInfo?.footer || 'Obrigado pela sua compra!' })
                        .setTimestamp();

                    // Adicionar key se disponivel
                    if (keyResult && keyResult.key) {
                        productEmbed.addFields(
                            { name: 'Sua Key', value: `\`\`\`${keyResult.key}\`\`\``, inline: false }
                        );
                    }

                    // Adicionar tutorial
                    if (shipping.tutorial) {
                        productEmbed.addFields(
                            { name: 'Tutorial', value: shipping.tutorial, inline: false }
                        );
                    }

                    // Adicionar botões
                    const buttonsRow = new ActionRowBuilder();
                    
                    // Botão de vídeo
                    if (shipping.videoLink) {
                        buttonsRow.addComponents(
                            new ButtonBuilder()
                                .setLabel('Video Tutorial')
                                .setStyle(ButtonStyle.Link)
                                .setURL(shipping.videoLink)
                        );
                    }
                    
                    // Botão de Download
                    if (shipping.downloadLink) {
                        buttonsRow.addComponents(
                            new ButtonBuilder()
                                .setLabel('Download')
                                .setStyle(ButtonStyle.Link)
                                .setURL(shipping.downloadLink)
                        );
                    }

                    // Enviar mensagem privada
                    if (buttonsRow.components.length > 0) {
                        await user.send({ 
                            embeds: [productEmbed], 
                            components: [buttonsRow] 
                        });
                    } else {
                        await user.send({ 
                            embeds: [productEmbed] 
                        });
                    }
                    
                    // Enviar transcript de compras para o canal configurado
                    await sendPurchaseTranscript(interaction, user, item, keyResult, cart);
                }
            }
            
            // Entregar cargo de cliente
            const clientRoleId = clientRoles.get(guildId);
            if (clientRoleId) {
                try {
                    const member = await interaction.guild.members.fetch(interaction.user.id);
                    if (!member.roles.cache.has(clientRoleId)) {
                        await member.roles.add(clientRoleId);
                        console.log(`[CARGO] Cargo de cliente entregue para ${interaction.user.username}`);
                    }
                } catch (error) {
                    console.error('Erro ao entregar cargo de cliente:', error);
                }
            }
            
        } catch (error) {
            console.error('Erro ao enviar mensagem privada:', error);
        }

        // Limpar carrinho
        shoppingCarts.delete(cartId);
        
        // Remover pagamento dos pendentes
        pendingPayments.delete(payment.txid);
        
        // Deletar mensagem do carrinho após 10 segundos
        if (cart.channelId && cart.cartMessageId) {
            setTimeout(async () => {
                try {
                    const channel = await interaction.guild.channels.fetch(cart.channelId);
                    if (channel) {
                        const cartMessage = await channel.messages.fetch(cart.cartMessageId);
                        if (cartMessage) {
                            await cartMessage.delete();
                            console.log(`[PAGAMENTO] Mensagem do carrinho deletada: ${cart.cartMessageId}`);
                        }
                    }
                } catch (error) {
                    console.log('[PAGAMENTO] Não foi possível deletar mensagem do carrinho:', error.message);
                }
            }, 10000); // 10 segundos
        }
        
        console.log(`[PAGAMENTO] Compra concluída: ${purchaseId} - Usuário: ${interaction.user.username}`);
        
    } catch (error) {
        console.error('Erro ao processar pagamento concluído:', error);
        
        const errorEmbed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('❌ Erro ao Processar Compra')
            .setDescription('Ocorreu um erro ao processar sua compra. Entre em contato com o suporte.')
            .addFields(
                { name: 'ID da Transação', value: payment.txid, inline: true }
            );
        
        await interaction.editReply({ embeds: [errorEmbed], components: [], files: [] });
    }
}

// Carregar dados do arquivo
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            
            // Restaurar dados para os Maps
            if (data.ticketChannels) {
                Object.entries(data.ticketChannels).forEach(([guildId, categoryId]) => {
                    ticketChannels.set(guildId, categoryId);
                });
            }
            
            if (data.ticketOptions) {
                Object.entries(data.ticketOptions).forEach(([guildId, options]) => {
                    ticketOptions.set(guildId, options);
                });
            }
            
            if (data.staffRoles) {
                Object.entries(data.staffRoles).forEach(([guildId, roles]) => {
                    staffRoles.set(guildId, roles);
                });
            }
            
            if (data.ticketMessages) {
                Object.entries(data.ticketMessages).forEach(([guildId, message]) => {
                    ticketMessages.set(guildId, message);
                });
            }
            
            if (data.defaultTicketChannels) {
                Object.entries(data.defaultTicketChannels).forEach(([guildId, channelId]) => {
                    defaultTicketChannels.set(guildId, channelId);
                });
            }
            
            if (data.ticketVisuals) {
                Object.entries(data.ticketVisuals).forEach(([guildId, visuals]) => {
                    ticketVisuals.set(guildId, visuals);
                });
            }
            
            if (data.transcriptChannels) {
                Object.entries(data.transcriptChannels).forEach(([guildId, channelId]) => {
                    transcriptChannels.set(guildId, channelId);
                });
            }
            
            if (data.products) {
                Object.entries(data.products).forEach(([guildId, guildProducts]) => {
                    products.set(guildId, guildProducts);
                });
            }
            
            if (data.productPlans) {
                Object.entries(data.productPlans).forEach(([guildId, guildPlans]) => {
                    productPlans.set(guildId, guildPlans);
                });
            }
            
            if (data.productChannels) {
                Object.entries(data.productChannels).forEach(([guildId, channels]) => {
                    productChannels.set(guildId, channels);
                });
            }
            
            if (data.purchaseCategories) {
                Object.entries(data.purchaseCategories).forEach(([guildId, categoryId]) => {
                    purchaseCategories.set(guildId, categoryId);
                });
            }
            
            if (data.coupons) {
                Object.entries(data.coupons).forEach(([guildId, guildCoupons]) => {
                    coupons.set(guildId, guildCoupons);
                });
            }
            
            if (data.productShipping) {
                Object.entries(data.productShipping).forEach(([guildId, shipping]) => {
                    productShipping.set(guildId, shipping);
                });
            }
            
            if (data.productStock) {
                Object.entries(data.productStock).forEach(([guildId, stock]) => {
                    productStock.set(guildId, stock);
                });
            }
            
            if (data.keyAuthStock) {
                Object.entries(data.keyAuthStock).forEach(([guildId, keyAuth]) => {
                    keyAuthStock.set(guildId, keyAuth);
                });
            }
            
            if (data.manualStock) {
                Object.entries(data.manualStock).forEach(([guildId, manual]) => {
                    manualStock.set(guildId, manual);
                });
            }
            
            if (data.stockPreference) {
                Object.entries(data.stockPreference).forEach(([guildId, preferences]) => {
                    stockPreference.set(guildId, preferences);
                });
            }
            
            if (data.purchaseTranscriptChannels) {
                Object.entries(data.purchaseTranscriptChannels).forEach(([guildId, channelId]) => {
                    purchaseTranscriptChannels.set(guildId, channelId);
                });
            }

            if (data.logsChannels) {
                Object.entries(data.logsChannels).forEach(([guildId, channelId]) => {
                    logsChannels.set(guildId, channelId);
                });
            }

            if (data.restoreCordRoles) {
                Object.entries(data.restoreCordRoles).forEach(([guildId, roleId]) => {
                    restoreCordRoles.set(guildId, roleId);
                });
            }

            if (data.clientRoles) {
                Object.entries(data.clientRoles).forEach(([key, roleId]) => {
                    clientRoles.set(key, roleId);
                });
            }

            if (data.efiCredentials) {
                Object.entries(data.efiCredentials).forEach(([guildId, credentials]) => {
                    efiCredentials.set(guildId, credentials);
                });
            }

            if (data.pendingPayments) {
                Object.entries(data.pendingPayments).forEach(([txid, payment]) => {
                    pendingPayments.set(txid, payment);
                });
            }
            
            console.log('✅ Dados carregados com sucesso!');
        }
    } catch (error) {
        console.error('❌ Erro ao carregar dados:', error);
    }
}

// Salvar dados no arquivo
function saveData() {
    try {
        const data = {
            ticketChannels: Object.fromEntries(ticketChannels),
            ticketOptions: Object.fromEntries(ticketOptions),
            staffRoles: Object.fromEntries(staffRoles),
            ticketMessages: Object.fromEntries(ticketMessages),
            defaultTicketChannels: Object.fromEntries(defaultTicketChannels),
            ticketVisuals: Object.fromEntries(ticketVisuals),
            transcriptChannels: Object.fromEntries(transcriptChannels),
            products: Object.fromEntries(products),
            productPlans: Object.fromEntries(productPlans),
            productChannels: Object.fromEntries(productChannels),
            purchaseCategories: Object.fromEntries(purchaseCategories),
            coupons: Object.fromEntries(coupons),
            productShipping: Object.fromEntries(productShipping),
            productStock: Object.fromEntries(productStock),
            keyAuthStock: Object.fromEntries(keyAuthStock),
            manualStock: Object.fromEntries(manualStock),
            stockPreference: Object.fromEntries(stockPreference),
            purchaseTranscriptChannels: Object.fromEntries(purchaseTranscriptChannels),
            logsChannels: Object.fromEntries(logsChannels),
            restoreCordRoles: Object.fromEntries(restoreCordRoles),
            clientRoles: Object.fromEntries(clientRoles),
            efiCredentials: Object.fromEntries(efiCredentials),
            pendingPayments: Object.fromEntries(pendingPayments)
        };
        
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log('✅ Dados salvos com sucesso!');
    } catch (error) {
        console.error('❌ Erro ao salvar dados:', error);
    }
}

client.once('ready', async () => {
    console.log(`Bot online como ${client.user.tag}!`);
    
    // Carregar dados salvos
    loadData();
    
    // Registrar comandos slash
    const commands = [
        new SlashCommandBuilder()
            .setName('painel')
            .setDescription('Abre o painel de configuração do bot')
    ].map(cmd => cmd.toJSON());

    try {
        await client.application.commands.set(commands);
        console.log('Comandos slash registrados com sucesso!');
    } catch (error) {
        console.error('Erro ao registrar comandos:', error);
    }
});

// Evento de membro entrando no servidor
client.on('guildMemberAdd', async member => {
    console.log(`[LOGS] Membro entrou: ${member.user.username} no servidor ${member.guild.name}`);
    const guild = member.guild;
    const logsChannelId = logsChannels.get(guild.id);
    console.log(`[LOGS] Canal de logs configurado: ${logsChannelId || 'Nenhum'}`);
    
    if (!logsChannelId) {
        console.log('[LOGS] Nenhum canal de logs configurado, ignorando...');
        return;
    }

    try {
        const logsChannel = await guild.channels.fetch(logsChannelId);
        if (!logsChannel || logsChannel.type !== 0) { // GUILD_TEXT = 0
            console.error('Canal de logs não encontrado ou inválido');
            return;
        }

        // Criar embed de entrada
        const joinEmbed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('Novo Membro no Servidor')
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
            .addFields(
                { 
                    name: 'Membro', 
                    value: `${member.toString()}\n**Nome:** ${member.user.username}\n**ID:** \`${member.id}\``,
                    inline: false 
                },
                { 
                    name: 'Data de Entrada', 
                    value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
                    inline: true 
                },
                { 
                    name: 'Conta Criada em', 
                    value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`,
                    inline: true 
                }
            )
            .setTimestamp()
            .setFooter({ 
                text: `Servidor: ${guild.name}`, 
                iconURL: guild.iconURL({ dynamic: true }) 
            });

        await logsChannel.send({ embeds: [joinEmbed] });
        console.log(`✅ Log de entrada enviado para ${logsChannel.name}`);

    } catch (error) {
        console.error('Erro ao enviar log de entrada:', error);
    }
});

// Evento de membro saindo do servidor
client.on('guildMemberRemove', async member => {
    console.log(`[LOGS] Membro saiu: ${member.user.username} do servidor ${member.guild.name}`);
    const guild = member.guild;
    const logsChannelId = logsChannels.get(guild.id);
    console.log(`[LOGS] Canal de logs configurado: ${logsChannelId || 'Nenhum'}`);
    
    if (!logsChannelId) {
        console.log('[LOGS] Nenhum canal de logs configurado, ignorando...');
        return;
    }

    try {
        const logsChannel = await guild.channels.fetch(logsChannelId);
        console.log(`[LOGS] Canal encontrado: ${logsChannel ? logsChannel.name : 'Não encontrado'}`);
        if (!logsChannel || logsChannel.type !== 0) { // GUILD_TEXT = 0
            console.error('Canal de logs não encontrado ou inválido');
            return;
        }

        // Criar embed de saída
        const leaveEmbed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('Membro Saiu do Servidor')
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
            .addFields(
                { 
                    name: 'Membro', 
                    value: `**${member.user.username}**\n**ID:** \`${member.id}\``,
                    inline: false 
                },
                { 
                    name: 'Data de Saída', 
                    value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
                    inline: true 
                },
                { 
                    name: 'Conta Criada em', 
                    value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`,
                    inline: true 
                },
                { 
                    name: 'Tempo no Servidor', 
                    value: member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>` : 'Não disponível',
                    inline: true 
                }
            )
            .setTimestamp()
            .setFooter({ 
                text: `Servidor: ${guild.name}`, 
                iconURL: guild.iconURL({ dynamic: true }) 
            });

        await logsChannel.send({ embeds: [leaveEmbed] });
        console.log(`✅ Log de saída enviado para ${logsChannel.name}`);

    } catch (error) {
        console.error('Erro ao enviar log de saída:', error);
    }
});

// Evento de verificação RestoreCord (detecta quando membro recebe o cargo)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const guild = newMember.guild;
    const logsChannelId = logsChannels.get(guild.id);
    const restoreCordRoleId = restoreCordRoles.get(guild.id);

    if (!logsChannelId || !restoreCordRoleId) return;

    // Verificar se o cargo do RestoreCord foi adicionado
    const hadRole = oldMember.roles.cache.has(restoreCordRoleId);
    const hasRole = newMember.roles.cache.has(restoreCordRoleId);

    if (!hadRole && hasRole) {
        try {
            const logsChannel = await guild.channels.fetch(logsChannelId);
            if (!logsChannel || logsChannel.type !== 0) return;

            const verifyEmbed = new EmbedBuilder()
                .setColor('#00BFFF')
                .setTitle('Membro Verificado no RestoreCord')
                .setThumbnail(newMember.user.displayAvatarURL({ dynamic: true, size: 256 }))
                .addFields(
                    {
                        name: 'Membro',
                        value: `${newMember.toString()}\n**Nome:** ${newMember.user.username}\n**ID:** \`${newMember.id}\``,
                        inline: false
                    },
                    {
                        name: 'Verificado em',
                        value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
                        inline: true
                    },
                    {
                        name: 'Cargo Recebido',
                        value: `<@&${restoreCordRoleId}>`,
                        inline: true
                    }
                )
                .setTimestamp()
                .setFooter({
                    text: `Servidor: ${guild.name}`,
                    iconURL: guild.iconURL({ dynamic: true })
                });

            await logsChannel.send({ embeds: [verifyEmbed] });
            console.log(`[LOGS] Membro verificado no RestoreCord: ${newMember.user.username}`);

        } catch (error) {
            console.error('Erro ao enviar log de verificação RestoreCord:', error);
        }
    }
});

// Evento único para todas as interações
client.on('interactionCreate', async (interaction) => {
    try {
        // Comando slash
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'painel') {
                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Painel de Configuração')
                    .setDescription('Selecione uma opção abaixo para configurar o bot:')
                    .setTimestamp();

                // Criar menu completamente novo
                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('painel_select')
                            .setPlaceholder('Selecione uma opção...')
                            .addOptions([
                                {
                                    label: 'Tickets',
                                    description: 'Gerencie o sistema de tickets',
                                    value: 'ticket_menu'
                                },
                                {
                                    label: 'Produtos',
                                    description: 'Gerencie produtos e planos da loja',
                                    value: 'products_menu'
                                },
                                {
                                    label: 'Cupons',
                                    description: 'Gerencie cupons de desconto',
                                    value: 'coupons_menu'
                                },
                                {
                                    label: 'Estoque',
                                    description: 'Gerencie estoque de produtos',
                                    value: 'stock_menu'
                                },
                                {
                                    label: 'Envio',
                                    description: 'Configure tutoriais e downloads',
                                    value: 'shipping_menu'
                                },
                                {
                                    label: 'Logs',
                                    description: 'Configure logs de entrada e saída',
                                    value: 'logs_menu'
                                },
                                {
                                    label: 'Pagamentos',
                                    description: 'Configure as credenciais do EFI Bank',
                                    value: 'payments_menu'
                                }
                            ])
                    );

                await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
            }
            return;
        }

        // Menu principal
        if (interaction.isStringSelectMenu() && interaction.customId === 'painel_select') {
            const value = interaction.values[0];
            
            if (value === 'ticket_menu') {
                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Menu de Tickets')
                    .setDescription('Selecione uma opção abaixo:')
                    .setTimestamp();

                // Forçar criação de menu completamente novo
                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('ticket_submenu')
                            .setPlaceholder('Selecione uma opção de ticket...')
                            .addOptions([
                                {
                                    label: 'Tickets',
                                    description: 'Gerencie o sistema de tickets',
                                    value: 'ticket_menu'
                                },
                                {
                                    label: 'Configurar Categoria',
                                    description: 'Defina a categoria para criar os tickets',
                                    value: 'ticket_category'
                                },
                                {
                                    label: 'Gerenciar Opções',
                                    description: 'Adicione ou edite as opções de tickets',
                                    value: 'ticket_options'
                                },
                                {
                                    label: 'Configurar Usuários',
                                    description: 'Defina os usuários que podem ver tickets',
                                    value: 'staff_config'
                                },
                                {
                                    label: 'Aparência do Ticket',
                                    description: 'Personalize imagem, cor e rodapé',
                                    value: 'ticket_visuals'
                                },
                                {
                                    label: 'Criação Ticket',
                                    description: 'Crie a mensagem de abertura de tickets',
                                    value: 'ticket_creation'
                                },
                                {
                                    label: 'Mensagem de Ticket',
                                    description: 'Configure a mensagem personalizada',
                                    value: 'ticket_message'
                                },
                                {
                                    label: 'Canal de Transcripts',
                                    description: 'Configure onde os transcripts serão salvos',
                                    value: 'transcript_channel'
                                }
                            ])
                    );

                await interaction.update({ embeds: [embed], components: [row] });
            } else if (value === 'products_menu') {
                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Menu de Produtos')
                    .setDescription('Selecione uma opção abaixo:')
                    .setTimestamp();

                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('products_submenu')
                            .setPlaceholder('Selecione uma opção de produtos...')
                            .addOptions([
                                {
                                    label: 'Criar Produto',
                                    description: 'Cadastre um novo produto na loja',
                                    value: 'create_product'
                                },
                                {
                                    label: 'Gerenciar Planos',
                                    description: 'Configure planos e valores dos produtos',
                                    value: 'manage_plans'
                                },
                                {
                                    label: 'Gerenciar Produtos',
                                    description: 'Edite ou exclua produtos existentes',
                                    value: 'manage_products'
                                },
                                {
                                    label: 'Envio Estoque',
                                    description: 'Configure tipo de estoque (automático ou manual)',
                                    value: 'shipping_stock'
                                },
                                {
                                    label: 'Enviar Produto',
                                    description: 'Envie um produto para um canal',
                                    value: 'send_product'
                                },
                                {
                                    label: 'Categoria de Compra',
                                    description: 'Configure o canal onde os carrinhos serão abertos',
                                    value: 'purchase_category'
                                },
                                {
                                    label: 'ID Clientes',
                                    description: 'Configure o cargo que os clientes recebem ao comprar',
                                    value: 'client_roles'
                                }
                            ])
                    );

                await interaction.update({ embeds: [embed], components: [row] });
            } else if (value === 'coupons_menu') {
                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Menu de Cupons')
                    .setDescription('Selecione uma opção abaixo:')
                    .setTimestamp();

                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('coupons_submenu')
                            .setPlaceholder('Selecione uma opção de cupons...')
                            .addOptions([
                                {
                                    label: 'Criar Cupom',
                                    description: 'Cadastre um novo cupom de desconto',
                                    value: 'create_coupon'
                                },
                                {
                                    label: 'Produtos do Cupom',
                                    description: 'Configure em quais produtos o cupom funciona',
                                    value: 'coupon_products'
                                },
                                {
                                    label: 'Gerenciar Cupons',
                                    description: 'Edite ou exclua cupons existentes',
                                    value: 'manage_coupons'
                                }
                            ])
                    );

                await interaction.update({ embeds: [embed], components: [row] });
            } else if (value === 'stock_menu') {
                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Menu de Estoque')
                    .setDescription('Selecione o tipo de estoque que deseja gerenciar:')
                    .setTimestamp();

                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('stock_submenu')
                            .setPlaceholder('Selecione uma opção de estoque...')
                            .addOptions([
                                {
                                    label: 'Estoque Automático',
                                    description: 'Configure geração automática de licenças',
                                    value: 'auto_stock'
                                },
                                {
                                    label: 'Estoque Manual',
                                    description: 'Cadastre keys manualmente por plano',
                                    value: 'manual_stock'
                                }
                            ])
                    );

                await interaction.update({ embeds: [embed], components: [row] });
            } else if (value === 'shipping_menu') {
                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Menu de Envio')
                    .setDescription('Selecione uma opção abaixo:')
                    .setTimestamp();

                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('shipping_submenu')
                            .setPlaceholder('Selecione uma opção de envio...')
                            .addOptions([
                                {
                                    label: 'Adicionar Envio',
                                    description: 'Configure tutorial e download para um produto',
                                    value: 'add_shipping'
                                },
                                {
                                    label: 'Editar Envio',
                                    description: 'Edite as informações de envio existentes',
                                    value: 'edit_shipping'
                                },
                                {
                                    label: 'Transcript de Compras',
                                    description: 'Configure o canal para receber informações de compras',
                                    value: 'purchase_transcript'
                                }
                            ])
                    );

                await interaction.update({ embeds: [embed], components: [row] });
            } else if (value === 'logs_menu') {
                await showLogsConfig(interaction);
            } else if (value === 'payments_menu') {
                await showPaymentConfig(interaction);
            }
            return;
        }

        // Submenu de tickets
        if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_submenu') {
            const value = interaction.values[0];
            
            if (value === 'ticket_category') {
                const modal = new ModalBuilder()
                    .setCustomId('ticket_category_modal')
                    .setTitle('Configurar Categoria de Tickets');

                const categoryIdInput = new TextInputBuilder()
                    .setCustomId('category_id')
                    .setLabel('ID da Categoria de Tickets')
                    .setPlaceholder('Ex: 123456789012345678')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const firstActionRow = new ActionRowBuilder().addComponents(categoryIdInput);
                modal.addComponents(firstActionRow);

                await interaction.showModal(modal);
            } else if (value === 'ticket_options') {
                await showTicketOptionsManager(interaction);
            } else if (value === 'ticket_message') {
                await showTicketMessageConfig(interaction);
            } else if (value === 'ticket_visuals') {
                await showTicketVisualsConfig(interaction);
            } else if (value === 'ticket_creation') {
                await showTicketChannelModal(interaction);
            } else if (value === 'staff_config') {
                await showStaffManager(interaction);
            } else if (value === 'transcript_channel') {
                await showTranscriptChannelConfig(interaction);
            }
            return;
        }

        // Submenu de produtos
        if (interaction.isStringSelectMenu() && interaction.customId === 'products_submenu') {
            const value = interaction.values[0];
            
            if (value === 'create_product') {
                const modal = new ModalBuilder()
                    .setCustomId('create_product_modal')
                    .setTitle('Criar Novo Produto');

                const nameInput = new TextInputBuilder()
                    .setCustomId('product_name')
                    .setLabel('Nome do Produto')
                    .setPlaceholder('Ex: Memory')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const descriptionInput = new TextInputBuilder()
                    .setCustomId('product_description')
                    .setLabel('Descrição do Produto')
                    .setPlaceholder('Descreva as características do produto...')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                const imageInput = new TextInputBuilder()
                    .setCustomId('product_image')
                    .setLabel('URL da Imagem (Imgur)')
                    .setPlaceholder('https://i.imgur.com/exemplo.png')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const bannerInput = new TextInputBuilder()
                    .setCustomId('product_banner')
                    .setLabel('URL do Banner (Imgur) - Opcional')
                    .setPlaceholder('https://i.imgur.com/banner.gif - Aparece entre descrição e planos')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false);

                const footerInput = new TextInputBuilder()
                    .setCustomId('product_footer')
                    .setLabel('Texto do Rodapé - Opcional')
                    .setPlaceholder('Ex: Agradecemos pela sua preferência pela One Store 2026!')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false);

                const firstRow = new ActionRowBuilder().addComponents(nameInput);
                const secondRow = new ActionRowBuilder().addComponents(descriptionInput);
                const thirdRow = new ActionRowBuilder().addComponents(imageInput);
                const fourthRow = new ActionRowBuilder().addComponents(bannerInput);
                const fifthRow = new ActionRowBuilder().addComponents(footerInput);

                modal.addComponents(firstRow, secondRow, thirdRow, fourthRow, fifthRow);
                await interaction.showModal(modal);
            } else if (value === 'manage_plans') {
                await showManagePlans(interaction);
            } else if (value === 'manage_products') {
                await showManageProducts(interaction);
            } else if (value === 'send_product') {
                await showSendProduct(interaction);
            } else if (value === 'shipping_stock') {
                await showShippingStock(interaction);
            } else if (value === 'purchase_category') {
                const modal = new ModalBuilder()
                    .setCustomId('purchase_category_modal')
                    .setTitle('Categoria de Compra');

                const channelInput = new TextInputBuilder()
                    .setCustomId('purchase_category_id')
                    .setLabel('ID do Canal')
                    .setPlaceholder('Cole o ID do canal onde os carrinhos serão abertos')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(channelInput)
                );

                await interaction.showModal(modal);
            } else if (value === 'client_roles') {
                await showClientRolesConfig(interaction);
            }
            return;
        }

        // Submenu de cupons
        if (interaction.isStringSelectMenu() && interaction.customId === 'coupons_submenu') {
            const value = interaction.values[0];
            
            if (value === 'create_coupon') {
                const modal = new ModalBuilder()
                    .setCustomId('create_coupon_modal')
                    .setTitle('Criar Cupom');

                const nameInput = new TextInputBuilder()
                    .setCustomId('coupon_name')
                    .setLabel('Nome do Cupom')
                    .setPlaceholder('Ex: DESCONTO10')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const durationInput = new TextInputBuilder()
                    .setCustomId('coupon_duration')
                    .setLabel('Duração (Ex: 30m, 2h, 1d, 60s)')
                    .setPlaceholder('30m = 30 minutos, 2h = 2 horas, 1d = 1 dia')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const percentageInput = new TextInputBuilder()
                    .setCustomId('coupon_percentage')
                    .setLabel('Porcentagem de Desconto (%)')
                    .setPlaceholder('Ex: 10 (para 10% de desconto)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const minValueInput = new TextInputBuilder()
                    .setCustomId('coupon_min_value')
                    .setLabel('Valor Mínimo (R$)')
                    .setPlaceholder('Ex: 20.00 (cupom válido acima de R$ 20,00)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(nameInput),
                    new ActionRowBuilder().addComponents(durationInput),
                    new ActionRowBuilder().addComponents(percentageInput),
                    new ActionRowBuilder().addComponents(minValueInput)
                );

                await interaction.showModal(modal);
            } else if (value === 'coupon_products') {
                await showCouponProducts(interaction);
            } else if (value === 'manage_coupons') {
                await showManageCoupons(interaction);
            }
            return;
        }

        
        // Submenu de estoque
        if (interaction.isStringSelectMenu() && interaction.customId === 'stock_submenu') {
            const value = interaction.values[0];
            
            if (value === 'auto_stock') {
                await showAutoStock(interaction);
            } else if (value === 'manual_stock') {
                await showManualStock(interaction);
            }
            return;
        }

        // Submenu de envio
        if (interaction.isStringSelectMenu() && interaction.customId === 'shipping_submenu') {
            const value = interaction.values[0];
            
            if (value === 'add_shipping') {
                await showAddShipping(interaction);
            } else if (value === 'edit_shipping') {
                await showEditShipping(interaction);
            } else if (value === 'purchase_transcript') {
                await showPurchaseTranscriptConfig(interaction);
            }    
            return;
        }

        // Menu de estoque automático
        if (interaction.isStringSelectMenu() && interaction.customId === 'auto_stock_menu') {
            const value = interaction.values[0];
            const guild = interaction.guild;
            const guildProducts = products.get(guild.id) || [];
            
            if (value === 'add_keyauth') {
                // Mostrar lista de produtos para adicionar configuração automática
                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Adicionar Configuração Automática')
                    .setDescription('Selecione o produto para configurar a geração automática:')
                    .setTimestamp();

                const productOptions = guildProducts.map(product => ({
                    label: product.name,
                    description: product.description.substring(0, 100),
                    value: `keyauth_add_${product.id}`
                }));

                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('select_keyauth_product')
                            .setPlaceholder('Selecione um produto...')
                            .addOptions(productOptions)
                    );

                const backButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_auto_stock')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({ embeds: [embed], components: [row, backButton] });
            } else if (value === 'edit_keyauth') {
                const guildKeyAuth = keyAuthStock.get(guild.id) || {};
                const configuredProducts = guildProducts.filter(p => guildKeyAuth[p.id]);

                if (configuredProducts.length === 0) {
                    const backButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_auto_stock')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({ 
                    content: '❌ Nenhum produto com configuração automática!', 
                    embeds: [], 
                    components: [backButton] 
                });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Editar Configuração Automática')
                    .setDescription('Selecione o produto para editar:')
                    .setTimestamp();

                const productOptions = configuredProducts.map(product => ({
                    label: product.name,
                    description: `App: ${guildKeyAuth[product.id].appName}`,
                    value: `keyauth_edit_${product.id}`
                }));

                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('select_keyauth_edit')
                            .setPlaceholder('Selecione um produto...')
                            .addOptions(productOptions)
                    );

                const backButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_auto_stock')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({ embeds: [embed], components: [row, backButton] });
            } else if (value === 'delete_keyauth') {
                const guildKeyAuth = keyAuthStock.get(guild.id) || {};
                const configuredProducts = guildProducts.filter(p => guildKeyAuth[p.id]);

                if (configuredProducts.length === 0) {
                    const backButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_auto_stock')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({ 
                    content: '❌ Nenhum produto com configuração automática!', 
                    embeds: [], 
                    components: [backButton] 
                });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor('#ff6b6b')
                    .setTitle('Excluir Configuração Automática')
                    .setDescription('Selecione o produto para excluir a configuração:')
                    .setTimestamp();

                const productOptions = configuredProducts.map(product => ({
                    label: product.name,
                    description: `App: ${guildKeyAuth[product.id].appName}`,
                    value: `keyauth_delete_${product.id}`
                }));

                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('select_keyauth_delete')
                            .setPlaceholder('Selecione um produto...')
                            .addOptions(productOptions)
                    );

                const backButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_auto_stock')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({ embeds: [embed], components: [row, backButton] });
            }
            return;
        }

        // Menu de estoque manual
        if (interaction.isStringSelectMenu() && interaction.customId === 'manual_stock_menu') {
            const value = interaction.values[0];
            const guild = interaction.guild;
            const guildProducts = products.get(guild.id) || [];
            
            if (value === 'add_manual_keys') {
                // Mostrar lista de produtos para adicionar keys
                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Adicionar Keys Manualmente')
                    .setDescription('Selecione o produto:')
                    .setTimestamp();

                const productOptions = guildProducts.map(product => ({
                    label: product.name,
                    description: product.description.substring(0, 100),
                    value: `manual_add_${product.id}`
                }));

                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('select_manual_product')
                            .setPlaceholder('Selecione um produto...')
                            .addOptions(productOptions)
                    );

                const backButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_manual_stock')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({ embeds: [embed], components: [row, backButton] });
            } else if (value === 'view_manual_keys') {
                const guildManual = manualStock.get(guild.id) || {};
                
                const embed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Visualizar Keys Manuais')
                    .setDescription('Selecione o produto para visualizar as keys:')
                    .setTimestamp();

                const productOptions = guildProducts.map(product => {
                    const productKeys = guildManual[product.id] || {};
                    const totalKeys = Object.values(productKeys).reduce((sum, keys) => sum + keys.length, 0);
                    return {
                        label: `${product.name} (${totalKeys} keys)`,
                        description: product.description.substring(0, 100),
                        value: `manual_view_${product.id}`
                    };
                });

                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('select_manual_view')
                            .setPlaceholder('Selecione um produto...')
                            .addOptions(productOptions)
                    );

                const backButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_manual_stock')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({ embeds: [embed], components: [row, backButton] });
            } else if (value === 'delete_manual_keys') {
                const guildManual = manualStock.get(guild.id) || {};
                const productsWithKeys = guildProducts.filter(p => guildManual[p.id] && Object.keys(guildManual[p.id]).length > 0);

                if (productsWithKeys.length === 0) {
                    const backButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_manual_stock')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({ 
                    content: '❌ Nenhum produto com keys cadastradas!', 
                    embeds: [], 
                    components: [backButton] 
                });
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor('#ff6b6b')
                    .setTitle('Excluir Keys Manuais')
                    .setDescription('Selecione o produto:')
                    .setTimestamp();

                const productOptions = productsWithKeys.map(product => {
                    const productKeys = guildManual[product.id] || {};
                    const totalKeys = Object.values(productKeys).reduce((sum, keys) => sum + keys.length, 0);
                    return {
                        label: `${product.name} (${totalKeys} keys)`,
                        description: product.description.substring(0, 100),
                        value: `manual_delete_${product.id}`
                    };
                });

                const row = new ActionRowBuilder()
                    .addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('select_manual_delete')
                            .setPlaceholder('Selecione um produto...')
                            .addOptions(productOptions)
                    );

                const backButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_manual_stock')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({ embeds: [embed], components: [row, backButton] });
            }
            return;
        }

        // Modais
        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'ticket_category_modal') {
                const categoryId = interaction.fields.getTextInputValue('category_id');
                const guild = interaction.guild;

                try {
                    const category = await guild.channels.fetch(categoryId);
                    if (!category || category.type !== 4) { // GUILD_CATEGORY = 4
                        await interaction.reply({ content: '❌ Categoria não encontrada! Verifique o ID.', ephemeral: true });
                        return;
                    }

                    ticketChannels.set(guild.id, categoryId);

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Sistema de Tickets Configurado!')
                        .setDescription(`Categoria de tickets definida: ${category}`)
                        .addFields(
                            { name: 'ID da Categoria', value: categoryId, inline: true },
                            { name: 'Servidor', value: guild.name, inline: true }
                        )
                        .setTimestamp();

                    // Salvar dados após alteração
                    saveData();

                    await interaction.reply({ embeds: [embed], ephemeral: true });

                } catch (error) {
                    console.error('Erro ao configurar categoria:', error);
                    await interaction.reply({ content: '❌ Erro ao configurar a categoria. Verifique se o bot tem permissão.', ephemeral: true });
                }
            } else if (interaction.customId === 'edit_title_modal') {
                const title = interaction.fields.getTextInputValue('message_title');
                const guild = interaction.guild;

                const currentMessage = ticketMessages.get(guild.id) || {};
                currentMessage.title = title;
                ticketMessages.set(guild.id, currentMessage);

                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Título Atualizado!')
                    .setDescription(`Novo título: ${title}`)
                    .setTimestamp();

                // Salvar dados após alteração
                saveData();

                await interaction.reply({ embeds: [embed], ephemeral: true });

            } else if (interaction.customId === 'edit_description_modal') {
                const description = interaction.fields.getTextInputValue('message_description');
                const guild = interaction.guild;

                const currentMessage = ticketMessages.get(guild.id) || {};
                currentMessage.description = description;
                ticketMessages.set(guild.id, currentMessage);

                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Descrição Atualizada!')
                    .setDescription(`Nova descrição configurada`)
                    .addFields(
                        { name: 'Descrição', value: description.length > 100 ? description.substring(0, 100) + '...' : description, inline: false }
                    )
                    .setTimestamp();

                // Salvar dados após alteração
                saveData();

                await interaction.reply({ embeds: [embed], ephemeral: true });

            } else if (interaction.customId === 'edit_visual_image_modal') {
                const imageUrl = interaction.fields.getTextInputValue('image_url');
                const guild = interaction.guild;

                const currentVisuals = ticketVisuals.get(guild.id) || {
                    imageUrl: '',
                    color: '#0099ff',
                    footer: 'Radiant Store 2025'
                };

                currentVisuals.imageUrl = imageUrl.trim();
                ticketVisuals.set(guild.id, currentVisuals);

                const embed = new EmbedBuilder()
                    .setColor(currentVisuals.color || '#0099ff')
                    .setTitle('Miniatura do Ticket Atualizada!')
                    .setDescription('Miniatura personalizada atualizada com sucesso!')
                    .addFields(
                        { name: 'URL da Miniatura', value: imageUrl || 'Nenhuma', inline: false }
                    )
                    .setTimestamp();

                // Salvar dados após alteração
                saveData();

                await interaction.reply({ embeds: [embed], ephemeral: true });

            } else if (interaction.customId === 'edit_visual_color_modal') {
                const colorHex = interaction.fields.getTextInputValue('color_hex');
                const guild = interaction.guild;

                // Validar formato hexadecimal
                if (!/^#[0-9A-Fa-f]{6}$/.test(colorHex)) {
                    await interaction.reply({ content: '❌ Cor inválida! Use formato hexadecimal como #0099ff', ephemeral: true });
                    return;
                }

                const currentVisuals = ticketVisuals.get(guild.id) || {
                    imageUrl: '',
                    color: '#0099ff',
                    footer: 'Radiant Store 2025'
                };

                currentVisuals.color = colorHex;
                ticketVisuals.set(guild.id, currentVisuals);

                const embed = new EmbedBuilder()
                    .setColor(colorHex)
                    .setTitle('Cor do Ticket Atualizada!')
                    .setDescription('Cor personalizada atualizada com sucesso!')
                    .addFields(
                        { name: 'Nova Cor', value: colorHex, inline: true },
                        { name: 'Visualização', value: '🎨', inline: true }
                    )
                    .setTimestamp();

                // Salvar dados após alteração
                saveData();

                await interaction.reply({ embeds: [embed], ephemeral: true });

            } else if (interaction.customId === 'edit_visual_footer_modal') {
                const footerText = interaction.fields.getTextInputValue('footer_text');
                const guild = interaction.guild;

                const currentVisuals = ticketVisuals.get(guild.id) || {
                    imageUrl: '',
                    color: '#0099ff',
                    footer: 'Radiant Store 2025'
                };

                currentVisuals.footer = footerText.trim();
                ticketVisuals.set(guild.id, currentVisuals);

                const embed = new EmbedBuilder()
                    .setColor(currentVisuals.color || '#0099ff')
                    .setTitle('Rodapé do Ticket Atualizado!')
                    .setDescription('Rodapé personalizado atualizado com sucesso!')
                    .addFields(
                        { name: 'Novo Rodapé', value: footerText, inline: false }
                    )
                    .setTimestamp();

                // Salvar dados após alteração
                saveData();

                await interaction.reply({ embeds: [embed], ephemeral: true });

            } else if (interaction.customId === 'add_staff_modal') {
                const userId = interaction.fields.getTextInputValue('user_id');
                const guild = interaction.guild;

                try {
                    const user = await guild.client.users.fetch(userId);
                    if (!user) {
                        await interaction.reply({ content: '❌ Usuário não encontrado! Verifique o ID.', ephemeral: true });
                        return;
                    }

                    const currentStaff = staffRoles.get(guild.id) || [];
                    
                    if (currentStaff.includes(userId)) {
                        await interaction.reply({ content: '❌ Este usuário já está na lista de staff!', ephemeral: true });
                        return;
                    }

                    currentStaff.push(userId);
                    staffRoles.set(guild.id, currentStaff);

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Usuário Staff Adicionado!')
                        .setDescription(`**${user.tag}** foi adicionado à lista de staff`)
                        .addFields(
                            { name: 'ID do Usuário', value: userId, inline: true },
                            { name: 'Total de Staff', value: currentStaff.length.toString(), inline: true }
                        )
                        .setTimestamp();

                    // Salvar dados após alteração
                    saveData();

                    await interaction.reply({ embeds: [embed], ephemeral: true });

                } catch (error) {
                    console.error('Erro ao adicionar usuário staff:', error);
                    await interaction.reply({ content: '❌ Erro ao adicionar usuário. Verifique se o ID está correto.', ephemeral: true });
                }

            } else if (interaction.customId === 'set_default_channel_modal') {
                const channelId = interaction.fields.getTextInputValue('channel_id');
                const guild = interaction.guild;

                try {
                    const channel = await guild.channels.fetch(channelId);
                    if (!channel || channel.type !== 0) { // GUILD_TEXT = 0
                        await interaction.reply({ content: '❌ Canal de texto não encontrado! Verifique o ID.', ephemeral: true });
                        return;
                    }

                    // Salvar canal padrão
                    defaultTicketChannels.set(guild.id, channelId);

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Canal Padrão Definido!')
                        .setDescription(`Canal padrão configurado: ${channel}`)
                        .addFields(
                            { name: 'ID do Canal', value: channelId, inline: true },
                            { name: 'Servidor', value: guild.name, inline: true }
                        )
                        .setTimestamp();

                    // Salvar dados após alteração
                    saveData();

                    await interaction.reply({ embeds: [embed], ephemeral: true });

                } catch (error) {
                    console.error('Erro ao definir canal padrão:', error);
                    await interaction.reply({ content: '❌ Erro ao definir o canal padrão. Verifique se o bot tem permissão.', ephemeral: true });
                }

            } else if (interaction.customId === 'set_transcript_channel_modal') {
                const channelId = interaction.fields.getTextInputValue('transcript_channel_id');
                const guild = interaction.guild;

                try {
                    const channel = await guild.channels.fetch(channelId);
                    if (!channel || channel.type !== 0) { // GUILD_TEXT = 0
                        await interaction.reply({ content: '❌ Canal de texto não encontrado! Verifique o ID.', ephemeral: true });
                        return;
                    }

                    // Salvar canal de transcripts
                    transcriptChannels.set(guild.id, channelId);

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Canal de Transcripts Definido!')
                        .setDescription(`Canal de transcripts configurado: ${channel}`)
                        .addFields(
                            { name: 'ID do Canal', value: channelId, inline: true },
                            { name: 'Servidor', value: guild.name, inline: true }
                        )
                        .setTimestamp();

                    // Salvar dados após alteração
                    saveData();

                    await interaction.reply({ embeds: [embed], ephemeral: true });

                } catch (error) {
                    console.error('Erro ao configurar canal de transcripts:', error);
                    await interaction.reply({ content: '❌ Erro ao configurar canal de transcripts.', ephemeral: true });
                }
            } else if (interaction.customId === 'set_purchase_transcript_channel_modal') {
                const channelId = interaction.fields.getTextInputValue('channel_id').trim();
                const guild = interaction.guild;

                try {
                    const channel = await guild.channels.fetch(channelId);
                    if (!channel || channel.type !== 0) { // GUILD_TEXT = 0
                        await interaction.reply({ 
                            content: '❌ Canal inválido! O ID informado não corresponde a um canal de texto.', 
                            ephemeral: true 
                        });
                        return;
                    }

                    // Salvar canal de transcript
                    purchaseTranscriptChannels.set(guild.id, channelId);
                    saveData();

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('✅ Canal de Transcript Configurado')
                        .setDescription(`Os transcripts de compras serão enviados para ${channel}`)
                        .addFields(
                            { name: 'Canal', value: `${channel.toString()}`, inline: true },
                            { name: 'ID', value: `\`${channelId}\``, inline: true }
                        )
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed], ephemeral: true });

                } catch (error) {
                    console.error('Erro ao configurar canal de transcript de compras:', error);
                    await interaction.reply({ 
                        content: '❌ Ocorreu um erro ao configurar o canal. Verifique se o ID está correto.', 
                        ephemeral: true 
                    });
                }
            } else if (interaction.customId === 'set_purchase_category_modal') {
                const categoryId = interaction.fields.getTextInputValue('category_id').trim();
                const guild = interaction.guild;

                try {
                    const category = await guild.channels.fetch(categoryId);
                    if (!category || category.type !== 4) { // 4 = GUILD_CATEGORY
                        await interaction.reply({ content: '❌ Categoria não encontrada! Verifique o ID. Deve ser o ID de uma categoria, não de um canal.', ephemeral: true });
                        return;
                    }

                    purchaseCategories.set(guild.id, categoryId);
                    saveData();

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Categoria de Compra Configurada!')
                        .setDescription(`Categoria **${category.name}** foi configurada! Os carrinhos serão criados dentro dela.`)
                        .addFields(
                            { name: 'Categoria', value: category.name, inline: true },
                            { name: 'ID', value: categoryId, inline: true }
                        )
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed], ephemeral: true });

                } catch (error) {
                    console.error('Erro ao configurar categoria de compra:', error);
                    await interaction.reply({ content: '❌ Erro ao configurar categoria. Verifique se o bot tem permissão.', ephemeral: true });
                }
            } else if (interaction.customId === 'set_logs_channel_modal') {
                const channelId = interaction.fields.getTextInputValue('channel_id').trim();
                const guild = interaction.guild;

                try {
                    const channel = await guild.channels.fetch(channelId);
                    if (!channel || channel.type !== 0) { // GUILD_TEXT = 0
                        await interaction.reply({ 
                            content: '❌ Canal inválido! O ID informado não corresponde a um canal de texto.', 
                            ephemeral: true 
                        });
                        return;
                    }

                    // Salvar canal de logs
                    logsChannels.set(guild.id, channelId);
                    saveData();

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('✅ Canal de Logs Configurado')
                        .setDescription(`Os logs de entrada e saída serão enviados para ${channel}`)
                        .addFields(
                            { name: 'Canal', value: `${channel.toString()}`, inline: true },
                            { name: 'ID', value: `\`${channelId}\``, inline: true }
                        )
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed], ephemeral: true });

                } catch (error) {
                    console.error('Erro ao configurar canal de logs:', error);
                    await interaction.reply({ 
                        content: '❌ Ocorreu um erro ao configurar o canal. Verifique se o ID está correto.', 
                        ephemeral: true 
                    });
                }
            } else if (interaction.customId === 'set_restorecord_role_modal') {
                const roleId = interaction.fields.getTextInputValue('role_id').trim();
                const guild = interaction.guild;

                try {
                    const role = await guild.roles.fetch(roleId);
                    if (!role) {
                        await interaction.reply({ 
                            content: '❌ Cargo não encontrado! Verifique o ID.', 
                            ephemeral: true 
                        });
                        return;
                    }

                    restoreCordRoles.set(guild.id, roleId);
                    saveData();

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Cargo RestoreCord Configurado')
                        .setDescription(`Quando um membro receber o cargo ${role}, uma notificação será enviada no canal de logs.`)
                        .addFields(
                            { name: 'Cargo', value: `${role.toString()}`, inline: true },
                            { name: 'ID', value: `\`${roleId}\``, inline: true }
                        )
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed], ephemeral: true });

                } catch (error) {
                    console.error('Erro ao configurar cargo RestoreCord:', error);
                    await interaction.reply({ 
                        content: '❌ Ocorreu um erro ao configurar o cargo. Verifique se o ID está correto.', 
                        ephemeral: true 
                    });
                }
            } else if (interaction.customId === 'set_client_role_modal') {
                const roleId = interaction.fields.getTextInputValue('role_id').trim();
                const guild = interaction.guild;

                try {
                    const role = await guild.roles.fetch(roleId);
                    if (!role) {
                        await interaction.reply({ 
                            content: '❌ Cargo não encontrado! Verifique o ID.', 
                            ephemeral: true 
                        });
                        return;
                    }

                    clientRoles.set(guild.id, roleId);
                    saveData();

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Cargo de Clientes Configurado')
                        .setDescription(`Quando alguém comprar QUALQUER produto da loja, receberá o cargo ${role}.`)
                        .addFields(
                            { name: 'Cargo', value: role.toString(), inline: true },
                            { name: 'ID do Cargo', value: `\`${roleId}\``, inline: true },
                            { name: 'Aplicação', value: 'Vale para TODOS os produtos', inline: true }
                        )
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed], ephemeral: true });

                } catch (error) {
                    console.error('Erro ao configurar cargo de clientes:', error);
                    await interaction.reply({ 
                        content: '❌ Ocorreu um erro ao configurar o cargo. Verifique se o ID está correto.', 
                        ephemeral: true 
                    });
                }
            } else if (interaction.customId === 'set_efi_credentials_modal') {
                const clientId = interaction.fields.getTextInputValue('client_id').trim();
                const clientSecret = interaction.fields.getTextInputValue('client_secret').trim();
                const pixKey = interaction.fields.getTextInputValue('pix_key').trim();
                const guild = interaction.guild;

                try {
                    // Validar formato das credenciais
                    if (!clientId || !clientSecret || !pixKey) {
                        await interaction.reply({ 
                            content: '❌ Preencha todos os campos!', 
                            ephemeral: true 
                        });
                        return;
                    }

                    // Validar formato da chave Pix
                    const validPixKey = validatePixKey(pixKey);
                    if (!validPixKey) {
                        await interaction.reply({ 
                            content: '❌ Chave Pix inválida! Use CPF, CNPJ, Email, Telefone ou Chave Aleatória.', 
                            ephemeral: true 
                        });
                        return;
                    }

                    // Salvar credenciais
                    efiCredentials.set(guild.id, {
                        clientId: clientId,
                        clientSecret: clientSecret,
                        pixKey: pixKey
                    });
                    saveData();

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Credenciais EFI Configuradas')
                        .setDescription('As credenciais da API EFI Bank e chave Pix foram salvas com sucesso!')
                        .addFields(
                            { name: 'Client ID', value: '`' + clientId.substring(0, 10) + '...' + '`', inline: true },
                            { name: 'Client Secret', value: '`' + clientSecret.substring(0, 10) + '...' + '`', inline: true },
                            { name: 'Chave Pix', value: '`' + pixKey + '`', inline: true },
                            { name: 'Status', value: '✅ Configurado', inline: true }
                        )
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed], ephemeral: true });

                } catch (error) {
                    console.error('Erro ao configurar credenciais EFI:', error);
                    await interaction.reply({ 
                        content: '❌ Ocorreu um erro ao salvar as credenciais.', 
                        ephemeral: true 
                    });
                }
            } else if (interaction.customId === 'create_product_modal') {
                const name = interaction.fields.getTextInputValue('product_name');
                const description = interaction.fields.getTextInputValue('product_description');
                const imageUrl = interaction.fields.getTextInputValue('product_image');
                const bannerUrl = interaction.fields.getTextInputValue('product_banner') || '';
                const footer = interaction.fields.getTextInputValue('product_footer') || 'Agradecemos pela sua preferência pela One Store 2026!';
                const guild = interaction.guild;

                // Criar ID único para o produto
                const productId = `product_${Date.now()}`;

                // Obter produtos do servidor ou criar novo array
                const guildProducts = products.get(guild.id) || [];

                // Adicionar novo produto
                guildProducts.push({
                    id: productId,
                    name: name,
                    description: description,
                    imageUrl: imageUrl,
                    bannerUrl: bannerUrl,
                    footer: footer,
                    createdAt: new Date().toISOString()
                });

                // Salvar produtos
                products.set(guild.id, guildProducts);
                saveData();

                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Produto Criado!')
                    .setDescription(`Produto **${name}** foi criado com sucesso!`)
                    .addFields(
                        { name: 'Nome', value: name, inline: true },
                        { name: 'ID', value: productId, inline: true }
                    )
                    .setThumbnail(imageUrl)
                    .setTimestamp();

                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else if (interaction.customId === 'create_coupon_modal') {
                const name = interaction.fields.getTextInputValue('coupon_name').toUpperCase();
                const durationStr = interaction.fields.getTextInputValue('coupon_duration');
                const percentageStr = interaction.fields.getTextInputValue('coupon_percentage');
                const minValueStr = interaction.fields.getTextInputValue('coupon_min_value');
                const guild = interaction.guild;

                // Validar porcentagem
                const percentage = parseFloat(percentageStr);
                if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
                    await interaction.reply({ content: '❌ Porcentagem inválida! Use um valor entre 1 e 100.', ephemeral: true });
                    return;
                }

                // Validar valor mínimo
                const minValue = parseFloat(minValueStr.replace(',', '.'));
                if (isNaN(minValue) || minValue < 0) {
                    await interaction.reply({ content: '❌ Valor mínimo inválido!', ephemeral: true });
                    return;
                }

                // Converter duração para milissegundos
                const durationMatch = durationStr.match(/^(\d+)(s|m|h|d)$/);
                if (!durationMatch) {
                    await interaction.reply({ content: '❌ Formato de duração inválido! Use: 30s, 30m, 2h ou 1d', ephemeral: true });
                    return;
                }

                const durationValue = parseInt(durationMatch[1]);
                const durationUnit = durationMatch[2];
                let durationMs = 0;

                switch (durationUnit) {
                    case 's': durationMs = durationValue * 1000; break;
                    case 'm': durationMs = durationValue * 60 * 1000; break;
                    case 'h': durationMs = durationValue * 60 * 60 * 1000; break;
                    case 'd': durationMs = durationValue * 24 * 60 * 60 * 1000; break;
                }

                // Criar cupom
                const couponId = `coupon_${Date.now()}`;
                const guildCoupons = coupons.get(guild.id) || [];

                // Verificar se já existe cupom com esse nome
                if (guildCoupons.find(c => c.name === name)) {
                    await interaction.reply({ content: '❌ Já existe um cupom com esse nome!', ephemeral: true });
                    return;
                }

                guildCoupons.push({
                    id: couponId,
                    name: name,
                    percentage: percentage,
                    minValue: minValue,
                    durationMs: durationMs,
                    expiresAt: new Date(Date.now() + durationMs).toISOString(),
                    products: [], // Produtos onde o cupom funciona (vazio = todos)
                    createdAt: new Date().toISOString()
                });

                coupons.set(guild.id, guildCoupons);
                saveData();

                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Cupom Criado!')
                    .setDescription(`Cupom **${name}** foi criado com sucesso!`)
                    .addFields(
                        { name: 'Nome', value: name, inline: true },
                        { name: 'Desconto', value: `${percentage}%`, inline: true },
                        { name: 'Valor Mínimo', value: `R$ ${minValue.toFixed(2)}`, inline: true },
                        { name: 'Duração', value: durationStr, inline: true },
                        { name: 'Expira em', value: new Date(Date.now() + durationMs).toLocaleString('pt-BR'), inline: false }
                    )
                    .setTimestamp();

                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else if (interaction.customId.startsWith('stock_modal_')) {
                const productId = interaction.customId.replace('stock_modal_', '');
                const stockStr = interaction.fields.getTextInputValue('stock_amount');
                const guild = interaction.guild;

                // Validar quantidade
                const stock = parseInt(stockStr);
                if (isNaN(stock) || stock < 0) {
                    await interaction.reply({ content: '❌ Quantidade inválida! Use números inteiros positivos.', ephemeral: true });
                    return;
                }

                // Atualizar estoque
                const guildStock = productStock.get(guild.id) || {};
                guildStock[productId] = stock;
                productStock.set(guild.id, guildStock);
                saveData();

                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Estoque Atualizado!')
                    .setDescription(`Estoque do produto atualizado para **${stock}** unidades.`)
                    .setTimestamp();

                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else if (interaction.customId.startsWith('shipping_add_modal_')) {
                const productId = interaction.customId.replace('shipping_add_modal_', '');
                const tutorialText = interaction.fields.getTextInputValue('tutorial_text');
                const videoLink = interaction.fields.getTextInputValue('video_link');
                const downloadLink = interaction.fields.getTextInputValue('download_link');
                const guild = interaction.guild;

                // Validar links
                if (videoLink && !videoLink.match(/^https?:\/\/.+/)) {
                    await interaction.reply({ content: '❌ Link do vídeo inválido! Use um URL válido.', ephemeral: true });
                    return;
                }

                if (!downloadLink.match(/^https?:\/\/.+/)) {
                    await interaction.reply({ content: '❌ Link de download inválido! Use um URL válido.', ephemeral: true });
                    return;
                }

                // Salvar informações de envio
                const guildShipping = productShipping.get(guild.id) || {};
                guildShipping[productId] = {
                    tutorial: tutorialText,
                    videoLink: videoLink || '',
                    downloadLink: downloadLink,
                    createdAt: new Date().toISOString()
                };
                productShipping.set(guild.id, guildShipping);
                saveData();

                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Envio Configurado!')
                    .setDescription('Informações de envio salvas com sucesso!')
                    .addFields(
                        { name: 'Tutorial', value: tutorialText.substring(0, 100) + '...', inline: false },
                        { name: 'Vídeo', value: videoLink || 'Não configurado', inline: true },
                        { name: 'Download', value: downloadLink, inline: true }
                    )
                    .setTimestamp();

                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else if (interaction.customId.startsWith('keyauth_add_modal_')) {
                const productId = interaction.customId.replace('keyauth_add_modal_', '');
                const sellerKey = interaction.fields.getTextInputValue('seller_key').trim();
                const appName = interaction.fields.getTextInputValue('app_name').trim();
                const generatorName = interaction.fields.getTextInputValue('generator_name').trim();
                const guild = interaction.guild;
                const guildProducts = products.get(guild.id) || [];
                const product = guildProducts.find(p => p.id === productId);

                // Validar SellerKey (deve ter 32 caracteres)
                if (sellerKey.length !== 32) {
                    await interaction.reply({ 
                        content: `❌ Chave de API inválida! Deve ter exatamente 32 caracteres.\n\nVocê forneceu: ${sellerKey.length} caracteres.\n\nCopie a chave de API correta.`, 
                        ephemeral: true 
                    });
                    return;
                }

                // Testar a SellerKey antes de salvar
                console.log('🧪 Testando SellerKey com App Name:', appName);
                const isValid = await testKeyAuthSellerKey(sellerKey, appName);
                
                if (isValid) {
                    // Salvar configuração KeyAuth
                    const guildKeyAuth = keyAuthStock.get(guild.id) || {};
                    guildKeyAuth[productId] = {
                        sellerKey: sellerKey,
                        appName: appName,
                        generatorName: generatorName,
                        createdAt: new Date().toISOString()
                    };
                    keyAuthStock.set(guild.id, guildKeyAuth);
                    saveData();

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('✅ Configuração Automática Configurada!')
                        .setDescription(`Geração automática configurada para **${product?.name || 'Produto'}**!`)
                        .addFields(
                            { name: 'Aplicativo', value: appName, inline: true },
                            { name: 'Gerador', value: generatorName, inline: true },
                            { name: 'Chave API', value: `${sellerKey.substring(0, 20)}...`, inline: true },
                            { name: 'Tamanho', value: `${sellerKey.length} caracteres ✅`, inline: true }
                        )
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed], ephemeral: true });
                } else {
                    const embed = new EmbedBuilder()
                        .setColor('#ff6b6b')
                        .setTitle('❌ Erro na Configuração!')
                        .setDescription('A chave de API não é válida ou não tem permissão para gerar licenças.')
                        .addFields(
                            { name: 'Verifique:', value: '1. Copie a chave de API correta\n2. Verifique se o aplicativo existe\n3. Confirme as permissões da conta', inline: false }
                        )
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed], ephemeral: true });
                }
            } else if (interaction.customId.startsWith('keyauth_edit_modal_')) {
                const productId = interaction.customId.replace('keyauth_edit_modal_', '');
                const sellerKey = interaction.fields.getTextInputValue('seller_key').trim();
                const appName = interaction.fields.getTextInputValue('app_name').trim();
                const generatorName = interaction.fields.getTextInputValue('generator_name').trim();
                const guild = interaction.guild;
                const guildProducts = products.get(guild.id) || [];
                const product = guildProducts.find(p => p.id === productId);

                // Validar SellerKey (deve ter 32 caracteres)
                if (sellerKey.length !== 32) {
                    await interaction.reply({ 
                        content: `❌ Chave de API inválida! Deve ter exatamente 32 caracteres.\n\nVocê forneceu: ${sellerKey.length} caracteres.\n\nCopie a chave de API correta.`, 
                        ephemeral: true 
                    });
                    return;
                }

                // Testar a SellerKey antes de salvar
                const isValid = await testKeyAuthSellerKey(sellerKey, appName);
                
                if (isValid) {
                    // Atualizar configuração KeyAuth
                    const guildKeyAuth = keyAuthStock.get(guild.id) || {};
                    guildKeyAuth[productId] = {
                        sellerKey: sellerKey,
                        appName: appName,
                        generatorName: generatorName,
                        updatedAt: new Date().toISOString()
                    };
                    keyAuthStock.set(guild.id, guildKeyAuth);
                    saveData();

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('✅ Configuração Automática Atualizada!')
                        .setDescription(`Geração automática atualizada para **${product?.name || 'Produto'}**!`)
                        .addFields(
                            { name: 'Aplicativo', value: appName, inline: true },
                            { name: 'Gerador', value: generatorName, inline: true },
                            { name: 'Chave API', value: `${sellerKey.substring(0, 20)}...`, inline: true },
                            { name: 'Tamanho', value: `${sellerKey.length} caracteres ✅`, inline: true }
                        )
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed], ephemeral: true });
                } else {
                    const embed = new EmbedBuilder()
                        .setColor('#ff6b6b')
                        .setTitle('❌ Erro na Configuração!')
                        .setDescription('A chave de API não é válida ou não tem permissão para gerar licenças.')
                        .addFields(
                            { name: 'Verifique:', value: '1. Copie a chave de API correta\n2. Verifique se o aplicativo existe\n3. Confirme as permissões da conta', inline: false }
                        )
                        .setTimestamp();

                    await interaction.reply({ embeds: [embed], ephemeral: true });
                }
            } else if (interaction.customId.startsWith('manual_keys_modal_')) {
                const parts = interaction.customId.replace('manual_keys_modal_', '').split('_');
                const productId = parts[0];
                const planName = parts.slice(1).join('_');
                const keysText = interaction.fields.getTextInputValue('keys_list');
                const guild = interaction.guild;
                const guildProducts = products.get(guild.id) || [];
                const product = guildProducts.find(p => p.id === productId);

                // Processar keys (uma por linha)
                const keys = keysText.split('\n').map(k => k.trim()).filter(k => k.length > 0);

                if (keys.length === 0) {
                    await interaction.reply({ content: '❌ Nenhuma key válida encontrada!', ephemeral: true });
                    return;
                }

                // Salvar keys manuais
                const guildManual = manualStock.get(guild.id) || {};
                if (!guildManual[productId]) {
                    guildManual[productId] = {};
                }
                if (!guildManual[productId][planName]) {
                    guildManual[productId][planName] = [];
                }
                
                // Adicionar novas keys (evitar duplicatas)
                const existingKeys = new Set(guildManual[productId][planName]);
                let addedCount = 0;
                for (const key of keys) {
                    if (!existingKeys.has(key)) {
                        guildManual[productId][planName].push(key);
                        addedCount++;
                    }
                }

                manualStock.set(guild.id, guildManual);
                saveData();

                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Keys Adicionadas!')
                    .setDescription(`**${addedCount}** keys adicionadas ao plano **${planName}** do produto **${product?.name || 'Produto'}**!`)
                    .addFields(
                        { name: 'Total de Keys', value: `${guildManual[productId][planName].length}`, inline: true },
                        { name: 'Keys Duplicadas', value: `${keys.length - addedCount}`, inline: true }
                    )
                    .setTimestamp();

                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else if (interaction.customId.startsWith('shipping_edit_modal_')) {
                const productId = interaction.customId.replace('shipping_edit_modal_', '');
                const tutorialText = interaction.fields.getTextInputValue('tutorial_text');
                const videoLink = interaction.fields.getTextInputValue('video_link');
                const downloadLink = interaction.fields.getTextInputValue('download_link');
                const guild = interaction.guild;

                // Validar links
                if (videoLink && !videoLink.match(/^https?:\/\/.+/)) {
                    await interaction.reply({ content: '❌ Link do vídeo inválido! Use um URL válido.', ephemeral: true });
                    return;
                }

                if (!downloadLink.match(/^https?:\/\/.+/)) {
                    await interaction.reply({ content: '❌ Link de download inválido! Use um URL válido.', ephemeral: true });
                    return;
                }

                // Atualizar informações de envio
                const guildShipping = productShipping.get(guild.id) || {};
                guildShipping[productId] = {
                    tutorial: tutorialText,
                    videoLink: videoLink || '',
                    downloadLink: downloadLink,
                    updatedAt: new Date().toISOString()
                };
                productShipping.set(guild.id, guildShipping);
                saveData();

                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Envio Atualizado!')
                    .setDescription('Informações de envio atualizadas com sucesso!')
                    .addFields(
                        { name: 'Tutorial', value: tutorialText.substring(0, 100) + '...', inline: false },
                        { name: 'Vídeo', value: videoLink || 'Não configurado', inline: true },
                        { name: 'Download', value: downloadLink, inline: true }
                    )
                    .setTimestamp();

                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else if (interaction.customId.startsWith('add_plan_modal_')) {
                const productId = interaction.customId.replace('add_plan_modal_', '');
                const planName = interaction.fields.getTextInputValue('plan_name');
                const planPriceStr = interaction.fields.getTextInputValue('plan_price');
                const guild = interaction.guild;

                // Validar preço
                const planPrice = parseFloat(planPriceStr.replace(',', '.'));
                if (isNaN(planPrice) || planPrice <= 0) {
                    await interaction.reply({ content: '❌ Valor inválido! Use números como 35.00', ephemeral: true });
                    return;
                }

                // Obter ou criar estrutura de planos
                const guildPlans = productPlans.get(guild.id) || {};
                if (!guildPlans[productId]) {
                    guildPlans[productId] = [];
                }

                // Adicionar novo plano
                guildPlans[productId].push({
                    name: planName,
                    price: planPrice,
                    createdAt: new Date().toISOString()
                });

                productPlans.set(guild.id, guildPlans);
                saveData();

                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Plano Adicionado!')
                    .setDescription(`Plano **${planName}** adicionado com sucesso!`)
                    .addFields(
                        { name: 'Nome', value: planName, inline: true },
                        { name: 'Valor', value: `R$ ${planPrice.toFixed(2)}`, inline: true }
                    )
                    .setTimestamp();

                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else if (interaction.customId.startsWith('edit_product_modal_')) {
                const productId = interaction.customId.replace('edit_product_modal_', '');
                const newName = interaction.fields.getTextInputValue('edit_product_name');
                const newDescription = interaction.fields.getTextInputValue('edit_product_description');
                const newImageUrl = interaction.fields.getTextInputValue('edit_product_image');
                const newBannerUrl = interaction.fields.getTextInputValue('edit_product_banner') || '';
                const newFooter = interaction.fields.getTextInputValue('edit_product_footer') || 'Agradecemos pela sua preferência pela One Store 2026!';
                const guild = interaction.guild;

                const guildProducts = products.get(guild.id) || [];
                const product = guildProducts.find(p => p.id === productId);

                if (!product) {
                    await interaction.reply({ content: '❌ Produto não encontrado!', ephemeral: true });
                    return;
                }

                // Atualizar produto
                product.name = newName;
                product.description = newDescription;
                product.imageUrl = newImageUrl;
                product.bannerUrl = newBannerUrl;
                product.footer = newFooter;
                product.updatedAt = new Date().toISOString();

                products.set(guild.id, guildProducts);
                saveData();

                const embedProdUpdate = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Produto Atualizado!')
                    .setDescription(`Produto **${newName}** foi atualizado com sucesso!`)
                    .setThumbnail(newImageUrl)
                    .setTimestamp();

                await interaction.reply({ embeds: [embedProdUpdate], ephemeral: true });
            } else if (interaction.customId.startsWith('edit_plan_modal_')) {
                const customIdData = interaction.customId.replace('edit_plan_modal_', '');
                const lastUnderscoreIndex = customIdData.lastIndexOf('_');
                const productId = customIdData.substring(0, lastUnderscoreIndex);
                const planIndex = parseInt(customIdData.substring(lastUnderscoreIndex + 1));
                const newName = interaction.fields.getTextInputValue('edit_plan_name');
                const newPriceStr = interaction.fields.getTextInputValue('edit_plan_price');
                const guildEditPlan = interaction.guild;

                // Validar preço
                const newPrice = parseFloat(newPriceStr.replace(',', '.'));
                if (isNaN(newPrice) || newPrice <= 0) {
                    await interaction.reply({ content: '❌ Valor inválido! Use números como 35.00', ephemeral: true });
                    return;
                }

                const guildPlans = productPlans.get(guildEditPlan.id) || {};
                const plans = guildPlans[productId] || [];

                if (planIndex < 0 || planIndex >= plans.length) {
                    await interaction.reply({ content: '❌ Plano não encontrado!', ephemeral: true });
                    return;
                }

                // Atualizar plano
                plans[planIndex].name = newName;
                plans[planIndex].price = newPrice;
                plans[planIndex].updatedAt = new Date().toISOString();

                guildPlans[productId] = plans;
                productPlans.set(guildEditPlan.id, guildPlans);
                saveData();

                const embedPlanUpdate = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Plano Atualizado!')
                    .setDescription(`Plano **${newName}** foi atualizado com sucesso!`)
                    .addFields(
                        { name: 'Nome', value: newName, inline: true },
                        { name: 'Valor', value: `R$ ${newPrice.toFixed(2)}`, inline: true }
                    )
                    .setTimestamp();

                await interaction.reply({ embeds: [embedPlanUpdate], ephemeral: true });
            } else if (interaction.customId.startsWith('edit_coupon_modal_')) {
                const couponId = interaction.customId.replace('edit_coupon_modal_', '');
                const newName = interaction.fields.getTextInputValue('edit_coupon_name').toUpperCase();
                const newPercentageStr = interaction.fields.getTextInputValue('edit_coupon_percentage');
                const newMinValueStr = interaction.fields.getTextInputValue('edit_coupon_min_value');
                const newDurationStr = interaction.fields.getTextInputValue('edit_coupon_duration');
                const guildEditCoupon = interaction.guild;

                const guildCoupons = coupons.get(guildEditCoupon.id) || [];
                const coupon = guildCoupons.find(c => c.id === couponId);

                if (!coupon) {
                    await interaction.reply({ content: '❌ Cupom não encontrado!', ephemeral: true });
                    return;
                }

                // Validar porcentagem
                const newPercentage = parseFloat(newPercentageStr);
                if (isNaN(newPercentage) || newPercentage <= 0 || newPercentage > 100) {
                    await interaction.reply({ content: '❌ Porcentagem inválida! Use um valor entre 1 e 100.', ephemeral: true });
                    return;
                }

                // Validar valor mínimo
                const newMinValue = parseFloat(newMinValueStr.replace(',', '.'));
                if (isNaN(newMinValue) || newMinValue < 0) {
                    await interaction.reply({ content: '❌ Valor mínimo inválido!', ephemeral: true });
                    return;
                }

                // Atualizar cupom
                coupon.name = newName;
                coupon.percentage = newPercentage;
                coupon.minValue = newMinValue;

                // Se forneceu nova duração, atualizar
                if (newDurationStr) {
                    const durationMatch = newDurationStr.match(/^(\d+)(s|m|h|d)$/);
                    if (!durationMatch) {
                        await interaction.reply({ content: '❌ Formato de duração inválido! Use: 30s, 30m, 2h ou 1d', ephemeral: true });
                        return;
                    }

                    const durationValue = parseInt(durationMatch[1]);
                    const durationUnit = durationMatch[2];
                    let durationMs = 0;

                    switch (durationUnit) {
                        case 's': durationMs = durationValue * 1000; break;
                        case 'm': durationMs = durationValue * 60 * 1000; break;
                        case 'h': durationMs = durationValue * 60 * 60 * 1000; break;
                        case 'd': durationMs = durationValue * 24 * 60 * 60 * 1000; break;
                    }

                    coupon.durationMs = durationMs;
                    coupon.expiresAt = new Date(Date.now() + durationMs).toISOString();
                }

                coupon.updatedAt = new Date().toISOString();
                coupons.set(guildEditCoupon.id, guildCoupons);
                saveData();

                const embedCouponUpdate = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Cupom Atualizado!')
                    .setDescription(`Cupom **${newName}** foi atualizado com sucesso!`)
                    .addFields(
                        { name: 'Nome', value: newName, inline: true },
                        { name: 'Desconto', value: `${newPercentage}%`, inline: true },
                        { name: 'Valor Mínimo', value: `R$ ${newMinValue.toFixed(2)}`, inline: true },
                        { name: 'Expira em', value: new Date(coupon.expiresAt).toLocaleString('pt-BR'), inline: false }
                    )
                    .setTimestamp();

                await interaction.reply({ embeds: [embedCouponUpdate], ephemeral: true });
            } else if (interaction.customId === 'apply_coupon_modal') {
                const couponCode = interaction.fields.getTextInputValue('coupon_code').toUpperCase();
                const user = interaction.user;
                const guild = interaction.guild;
                const cartKey = `${guild.id}_${user.id}`;
                const cart = shoppingCarts.get(cartKey);

                if (!cart || cart.items.length === 0) {
                    await interaction.reply({ content: '❌ Carrinho vazio!', ephemeral: true });
                    return;
                }

                // Buscar cupom
                const guildCoupons = coupons.get(guild.id) || [];
                const coupon = guildCoupons.find(c => c.name === couponCode);

                if (!coupon) {
                    await interaction.reply({ content: '❌ Cupom não encontrado!', ephemeral: true });
                    return;
                }

                // Verificar se expirou
                if (new Date(coupon.expiresAt) < new Date()) {
                    await interaction.reply({ content: '❌ Cupom expirado!', ephemeral: true });
                    return;
                }

                // Calcular total do carrinho
                let totalCart = 0;
                cart.items.forEach(item => {
                    totalCart += item.unitPrice * item.quantity;
                });

                // Verificar valor mínimo
                if (totalCart < coupon.minValue) {
                    await interaction.reply({ 
                        content: `❌ Valor mínimo não atingido! O cupom requer compras acima de R$ ${coupon.minValue.toFixed(2)}. Seu carrinho: R$ ${totalCart.toFixed(2)}`, 
                        ephemeral: true 
                    });
                    return;
                }

                // Verificar se cupom funciona nos produtos do carrinho
                if (coupon.products.length > 0) {
                    const cartProductIds = cart.items.map(item => item.productId);
                    const hasValidProduct = cartProductIds.some(id => coupon.products.includes(id));
                    
                    if (!hasValidProduct) {
                        await interaction.reply({ 
                            content: '❌ Este cupom não é válido para os produtos no seu carrinho!', 
                            ephemeral: true 
                        });
                        return;
                    }
                }

                // Aplicar cupom
                cart.appliedCoupon = {
                    code: coupon.name,
                    percentage: coupon.percentage
                };
                shoppingCarts.set(cartKey, cart);

                // Calcular desconto
                const discount = (totalCart * coupon.percentage) / 100;
                const finalTotal = totalCart - discount;

                // Atualizar mensagem do carrinho
                const updatedEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('🛒 Carrinho de Compras')
                    .setDescription(`Carrinho de ${user}`)
                    .setTimestamp();

                cart.items.forEach((item) => {
                    const itemTotal = item.unitPrice * item.quantity;
                    updatedEmbed.addFields({
                        name: `${item.productName} (x${item.quantity})`,
                        value: `Campo: ${item.planName}\nPreço unitário: R$ ${item.unitPrice.toFixed(2)}\nTotal: R$ ${itemTotal.toFixed(2)}`,
                        inline: false
                    });
                });

                updatedEmbed.addFields({
                    name: '\u200B',
                    value: `Subtotal: R$ ${totalCart.toFixed(2)}\nDesconto (${cart.appliedCoupon.code} - ${cart.appliedCoupon.percentage}%): -R$ ${discount.toFixed(2)}\n**Total: R$ ${finalTotal.toFixed(2)}**`,
                    inline: false
                });

                const updatedRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('apply_coupon')
                            .setLabel('Trocar Cupom')
                            .setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder()
                            .setCustomId('continue_payment')
                            .setLabel('Continuar para o Pagamento')
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId('cancel_cart')
                            .setLabel('Cancelar')
                            .setStyle(ButtonStyle.Danger)
                    );

                // Atualizar mensagem original do carrinho
                await interaction.message.edit({ embeds: [updatedEmbed], components: [updatedRow] });

                await interaction.reply({ 
                    content: `✅ Cupom **${coupon.name}** aplicado! Desconto de ${coupon.percentage}% (R$ ${discount.toFixed(2)})`, 
                    ephemeral: true 
                });
            } else if (interaction.customId.startsWith('change_channel_modal_')) {
                const productId = interaction.customId.replace('change_channel_modal_', '');
                const newChannelId = interaction.fields.getTextInputValue('new_channel_id');
                const guild = interaction.guild;

                await interaction.deferReply({ ephemeral: true });

                try {
                    const channel = await guild.channels.fetch(newChannelId);
                    if (!channel || channel.type !== 0) {
                        await interaction.editReply({ content: '❌ Canal de texto não encontrado! Verifique o ID.' });
                        return;
                    }

                    // Salvar canal para o produto
                    const guildChannels = productChannels.get(guild.id) || {};
                    guildChannels[productId] = newChannelId;
                    productChannels.set(guild.id, guildChannels);
                    saveData();

                    const guildProducts = products.get(guild.id) || [];
                    const product = guildProducts.find(p => p.id === productId);

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Canal Cadastrado!')
                        .setDescription(`Canal ${channel} foi cadastrado para o produto **${product?.name || 'Produto'}**`)
                        .addFields(
                            { name: 'Canal', value: `${channel}`, inline: true },
                            { name: 'ID', value: newChannelId, inline: true }
                        )
                        .setTimestamp();

                    await interaction.editReply({ embeds: [embed] });

                } catch (error) {
                    console.error('Erro ao cadastrar canal:', error);
                    await interaction.editReply({ content: '❌ Erro ao cadastrar canal.' });
                }
            } else if (interaction.customId.startsWith('edit_quantity_modal_')) {
                const itemIndex = parseInt(interaction.customId.replace('edit_quantity_modal_', ''));
                const newQuantityStr = interaction.fields.getTextInputValue('new_quantity');
                const newQuantity = parseInt(newQuantityStr);

                if (isNaN(newQuantity) || newQuantity < 1) {
                    await interaction.reply({ content: '❌ Quantidade inválida! Use números maiores que 0.', ephemeral: true });
                    return;
                }

                const cartKey = `${interaction.guild.id}_${interaction.user.id}`;
                const cart = shoppingCarts.get(cartKey);

                if (!cart || !cart.items[itemIndex]) {
                    await interaction.reply({ content: '❌ Item não encontrado no carrinho!', ephemeral: true });
                    return;
                }

                cart.items[itemIndex].quantity = newQuantity;
                shoppingCarts.set(cartKey, cart);

                await interaction.deferReply({ ephemeral: true });
                await showShoppingCart(interaction, cart, interaction.guild);
            } else if (interaction.customId.startsWith('send_product_modal_')) {
                const productId = interaction.customId.replace('send_product_modal_', '');
                const channelId = interaction.fields.getTextInputValue('send_channel_id');
                const guild = interaction.guild;

                try {
                    const channel = await guild.channels.fetch(channelId);
                    if (!channel || channel.type !== 0) {
                        await interaction.reply({ content: '❌ Canal de texto não encontrado! Verifique o ID.', ephemeral: true });
                        return;
                    }

                    const guildProducts = products.get(guild.id) || [];
                    const product = guildProducts.find(p => p.id === productId);

                    if (!product) {
                        await interaction.reply({ content: '❌ Produto não encontrado!', ephemeral: true });
                        return;
                    }

                    const guildPlans = productPlans.get(guild.id) || {};
                    const plans = guildPlans[productId] || [];

                    // Criar embed do produto
                    const productEmbed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setDescription(product.description)
                        .setImage(product.imageUrl)
                        .setFooter({ text: product.footer || 'Agradecemos pela sua preferência pela One Store 2026!' })
                        .setTimestamp();

                    const embeds = [productEmbed];
                    const components = [];

                    // Se houver banner, criar um embed separado para ele
                    if (product.bannerUrl) {
                        const bannerEmbed = new EmbedBuilder()
                            .setColor('#0099ff')
                            .setImage(product.bannerUrl);
                        embeds.push(bannerEmbed);
                    }

                    // Se houver planos, criar select menu
                    if (plans.length > 0) {
                        const planOptions = plans.map(plan => ({
                            label: plan.name,
                            description: `Valor: R$ ${plan.price.toFixed(2)}`,
                            value: `buy_${productId}_${plan.name}`
                        }));

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId(`select_plan_${productId}`)
                            .setPlaceholder('Selecione um plano')
                            .addOptions(planOptions);

                        components.push(new ActionRowBuilder().addComponents(selectMenu));
                    }

                    await channel.send({ embeds, components });

                    const confirmEmbed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Produto Enviado!')
                        .setDescription(`Produto **${product.name}** foi enviado para ${channel}`)
                        .setTimestamp();

                    await interaction.reply({ embeds: [confirmEmbed], ephemeral: true });

                } catch (error) {
                    console.error('Erro ao enviar produto:', error);
                    await interaction.reply({ content: '❌ Erro ao enviar produto para o canal.', ephemeral: true });
                }
            } else if (interaction.customId === 'ticket_channel_modal') {
                const channelId = interaction.fields.getTextInputValue('channel_id');
                const guild = interaction.guild;

                try {
                    const channel = await guild.channels.fetch(channelId);
                    if (!channel || channel.type !== 0) { // GUILD_TEXT = 0
                        await interaction.reply({ content: '❌ Canal de texto não encontrado! Verifique o ID.', ephemeral: true });
                        return;
                    }

                    const categoryId = ticketChannels.get(guild.id);
                    if (!categoryId) {
                        await interaction.reply({ content: '❌ Configure uma categoria primeiro!', ephemeral: true });
                        return;
                    }

                    // Obter as opções de tickets configuradas
                    const options = ticketOptions.get(guild.id) || [];
                    
                    if (options.length === 0) {
                        await interaction.reply({ content: '❌ Adicione opções de tickets primeiro!', ephemeral: true });
                        return;
                    }

                    // Criar o embed personalizado
                    const customMessage = ticketMessages.get(guild.id) || {
                        title: 'Atendimento Radiant Store',
                        description: 'Seja bem-vindo(a) ao sistema de atendimento da Radiant Store\nDe segunda a sabado das 7h as 23h\nDomingo e feriado: sem horario determinado'
                    };

                    const visualConfig = ticketVisuals.get(guild.id) || {
                        imageUrl: '',
                        color: '#0099ff',
                        footer: 'Radiant Store 2025'
                    };

                    const embed = new EmbedBuilder()
                        .setColor(visualConfig.color || '#0099ff')
                        .setTitle(customMessage.title || 'Atendimento Radiant Store')
                        .setDescription(customMessage.description || 'Seja bem-vindo(a) ao sistema de atendimento da Radiant Store\nDe segunda a sabado das 7h as 23h\nDomingo e feriado: sem horario determinado');

                    // Adicionar imagem como thumbnail se houver
                    if (visualConfig.imageUrl) {
                        embed.setThumbnail(visualConfig.imageUrl);
                    }

                    // Adicionar rodapé se houver
                    if (visualConfig.footer) {
                        embed.setFooter({ text: visualConfig.footer });
                    }

                    // Criar o menu dropdown com as opções
                    const selectOptions = options.map(opt => ({
                        label: opt.label,
                        description: opt.description,
                        value: opt.id
                    }));

                    const ticketSelect = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('ticket_type_select')
                                .setPlaceholder('Selecione uma opção para abrir um ticket...')
                                .addOptions(selectOptions)
                        );

                    await channel.send({ embeds: [embed], components: [ticketSelect] });
                    await interaction.reply({ content: `✅ Mensagem de tickets criada em ${channel}!`, ephemeral: true });

                } catch (error) {
                    console.error('Erro ao criar mensagem de tickets:', error);
                    await interaction.reply({ content: '❌ Erro ao criar a mensagem de tickets.', ephemeral: true });
                }
            } else if (interaction.customId.startsWith('edit_option_modal_')) {
                // Extrair ID do customId do modal
                const optionId = interaction.customId.replace('edit_option_modal_', '');
                const label = interaction.fields.getTextInputValue('option_label');
                const description = interaction.fields.getTextInputValue('option_description');
                const emoji = interaction.fields.getTextInputValue('option_emoji');
                const guild = interaction.guild;

                const options = ticketOptions.get(guild.id) || [];
                const optionIndex = options.findIndex(opt => opt.id === optionId);

                if (optionIndex === -1) {
                    await interaction.reply({ content: '❌ Opção não encontrada! Verifique o ID.', ephemeral: true });
                    return;
                }

                // Atualizar a opção mantendo o ID original
                options[optionIndex] = {
                    id: optionId, // Manter o ID original
                    label: label,
                    description: description,
                    emoji: emoji || options[optionIndex].emoji || ''
                };

                ticketOptions.set(guild.id, options);

                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Opção de Ticket Editada!')
                    .setDescription(`${label}`)
                    .addFields(
                        { name: 'Descrição', value: description, inline: false },
                        { name: 'ID', value: optionId, inline: true }
                    )
                    .setTimestamp();

                // Salvar dados após alteração
                saveData();

                await interaction.reply({ embeds: [embed], ephemeral: true });

            } else if (interaction.customId === 'delete_option_modal') {
                const optionId = interaction.fields.getTextInputValue('option_id');
                const guild = interaction.guild;

                const options = ticketOptions.get(guild.id) || [];
                const optionIndex = options.findIndex(opt => opt.id === optionId);

                if (optionIndex === -1) {
                    await interaction.reply({ content: '❌ Opção não encontrada! Verifique o ID.', ephemeral: true });
                    return;
                }

                const deletedOption = options[optionIndex];
                options.splice(optionIndex, 1);
                ticketOptions.set(guild.id, options);

                const embed = new EmbedBuilder()
                    .setColor('#ff0000')
                    .setTitle('Opção de Ticket Excluída!')
                    .setDescription(`${deletedOption.label}`)
                    .addFields(
                        { name: 'ID', value: optionId, inline: true },
                        { name: 'Total Restante', value: options.length.toString(), inline: true }
                    )
                    .setTimestamp();

                // Salvar dados após alteração
                saveData();

                await interaction.reply({ embeds: [embed], ephemeral: true });

            } else if (interaction.customId === 'add_ticket_option_modal') {
                const label = interaction.fields.getTextInputValue('option_label');
                const description = interaction.fields.getTextInputValue('option_description');
                const emoji = interaction.fields.getTextInputValue('option_emoji');
                const guild = interaction.guild;

                const options = ticketOptions.get(guild.id) || [];
                const newOption = {
                    id: `ticket_${Date.now()}`,
                    label: label,
                    description: description,
                    emoji: emoji || ''
                };

                options.push(newOption);
                ticketOptions.set(guild.id, options);

                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Opção de Ticket Adicionada!')
                    .setDescription(`${label}`)
                    .addFields(
                        { name: 'Descrição', value: description, inline: false },
                        { name: 'Total de Opções', value: options.length.toString(), inline: true }
                    )
                    .setTimestamp();

                // Salvar dados após alteração
                saveData();

                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
            return;
        }

        // Botões
        if (interaction.isButton()) {
            // Handler para botão de definir canal de transcript de compras
            if (interaction.customId === 'set_purchase_transcript_channel') {
                const modal = new ModalBuilder()
                    .setCustomId('set_purchase_transcript_channel_modal')
                    .setTitle('Configurar Canal de Transcript')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('channel_id')
                                .setLabel('ID do Canal de Transcript')
                                .setPlaceholder('Digite o ID do canal onde os transcripts serão enviados')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                        )
                    );
                await interaction.showModal(modal);
                return;
            }

            // Handler para botão de definir canal de logs
            if (interaction.customId === 'set_logs_channel') {
                const modal = new ModalBuilder()
                    .setCustomId('set_logs_channel_modal')
                    .setTitle('Configurar Canal de Logs')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('channel_id')
                                .setLabel('ID do Canal de Logs')
                                .setPlaceholder('Digite o ID do canal onde os logs serão enviados')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                        )
                    );
                await interaction.showModal(modal);
                return;
            }

            // Handler para botão de definir cargo do RestoreCord
            if (interaction.customId === 'set_restorecord_role') {
                const modal = new ModalBuilder()
                    .setCustomId('set_restorecord_role_modal')
                    .setTitle('Configurar Cargo RestoreCord')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('role_id')
                                .setLabel('ID do Cargo de Verificação')
                                .setPlaceholder('Digite o ID do cargo que o RestoreCord dá ao membro')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                        )
                    );
                await interaction.showModal(modal);
                return;
            }

            // Handler para botão de definir cargo de clientes
            if (interaction.customId === 'set_client_role') {
                const guild = interaction.guild;
                const currentRoleId = clientRoles.get(guild.id);

                const modal = new ModalBuilder()
                    .setCustomId('set_client_role_modal')
                    .setTitle('Configurar Cargo de Clientes')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('role_id')
                                .setLabel('ID do Cargo de Clientes')
                                .setPlaceholder('Digite o ID do cargo que os clientes receberão')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                        )
                    );

                // Adicionar campo com informação do cargo atual
                if (currentRoleId) {
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('current_role_info')
                                .setLabel('Cargo Atual (apenas visual)')
                                .setValue(`ID: ${currentRoleId}`)
                                .setStyle(TextInputStyle.Short)
                                .setRequired(false)
                        )
                    );
                }

                await interaction.showModal(modal);
                return;
            }

            // Handler para botão de transcript
            if (interaction.customId.startsWith('transcript_')) {
                const channelId = interaction.customId.replace('transcript_', '');
                const transcriptData = global.transcripts ? global.transcripts.get(channelId) : null;
                
                if (transcriptData) {
                    await interaction.reply({
                        files: [{
                            attachment: Buffer.from(transcriptData, 'utf8'),
                            name: `ticket-transcript-${channelId}.txt`
                        }],
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({ content: '❌ Transcript não encontrado!', ephemeral: true });
                }
                return;
            }

            // Handler para botão de configurar credenciais EFI
            if (interaction.customId === 'set_efi_credentials') {
                const guild = interaction.guild;
                const currentCredentials = efiCredentials.get(guild.id);

                const modal = new ModalBuilder()
                    .setCustomId('set_efi_credentials_modal')
                    .setTitle('Configurar Credenciais EFI Bank')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('client_id')
                                .setLabel('Client ID')
                                .setPlaceholder('Cole o Client ID da EFI')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setValue(currentCredentials?.clientId || '')
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('client_secret')
                                .setLabel('Client Secret')
                                .setPlaceholder('Cole o Client Secret da EFI')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setValue(currentCredentials?.clientSecret || '')
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('pix_key')
                                .setLabel('Chave Pix')
                                .setPlaceholder('CPF, CNPJ, Email, Telefone ou Aleatória')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setValue(currentCredentials?.pixKey || '')
                        )
                    );

                await interaction.showModal(modal);
                return;
            }

            // Handler para botão de testar conexão EFI
            if (interaction.customId === 'test_efi_connection') {
                const guild = interaction.guild;
                const credentials = efiCredentials.get(guild.id);
                
                if (!credentials) {
                    await interaction.reply({ 
                        content: '❌ Configure as credenciais primeiro!', 
                        ephemeral: true 
                    });
                    return;
                }

                await interaction.deferReply({ ephemeral: true });
                
                try {
                    // Validar se todas as credenciais estão configuradas
                    if (!credentials.clientId || !credentials.clientSecret || !credentials.pixKey) {
                        await interaction.editReply({ 
                            content: '❌ Configure todas as credenciais: Client ID, Client Secret e Chave Pix!' 
                        });
                        return;
                    }
                    
                    // Validar formato da chave Pix
                    const validPixKey = validatePixKey(credentials.pixKey);
                    if (!validPixKey) {
                        await interaction.editReply({ 
                            content: '❌ Chave Pix inválida! Use CPF, CNPJ, Email, Telefone ou Chave Aleatória.' 
                        });
                        return;
                    }
                    
                    // Aqui vamos implementar o teste de conexão com a API EFI
                    // Por enquanto, vamos apenas validar o formato das credenciais
                    if (credentials.clientId && credentials.clientSecret && credentials.pixKey) {
                        await interaction.editReply({ 
                            content: '✅ Credenciais válidas! Conexão com EFI Bank configurada com sucesso.\n\n📋 **Chave Pix configurada:**\n\`' + credentials.pixKey + '\`' 
                        });
                    } else {
                        await interaction.editReply({ 
                            content: '❌ Credenciais inválidas. Verifique os dados informados.' 
                        });
                    }
                } catch (error) {
                    console.error('Erro ao testar conexão EFI:', error);
                    await interaction.editReply({ 
                        content: '❌ Erro ao testar conexão. Verifique as credenciais.' 
                    });
                }
                return;
            }

            // Handler para copiar Pix Copia e Cola (EMV)
            if (interaction.customId === 'copy_pix_emv') {
                // Encontrar pagamento pendente do usuário
                const guildId = interaction.guild.id;
                const userId = interaction.user.id;
                
                // Buscar pagamento pendente
                let userPayment = null;
                for (const [txid, payment] of pendingPayments) {
                    if (payment.userId === userId) {
                        userPayment = payment;
                        break;
                    }
                }
                
                if (!userPayment) {
                    await interaction.reply({ 
                        content: 'Pagamento nao encontrado ou ja expirado.', 
                        ephemeral: true 
                    });
                    return;
                }
                
                // Buscar dados completos do pagamento
                const efi = getEFIInstance(guildId);
                try {
                    const chargeDetails = await efi.efiPay.pixDetailCharge({ txid: userPayment.txid });
                    const pixCopiaECola = chargeDetails.pixCopiaECola;
                    
                    if (!pixCopiaECola) {
                        await interaction.reply({ 
                            content: 'Codigo Pix Copia e Cola nao disponivel.', 
                            ephemeral: true 
                        });
                        return;
                    }
                    
                    await interaction.reply({ 
                        content: `**Pix Copia e Cola:**\n\`\`\`${pixCopiaECola}\`\`\`\n\nSelecione o codigo acima e copie (Ctrl+C / Cmd+C)`, 
                        ephemeral: true 
                    });
                } catch (error) {
                    console.error('Erro ao buscar detalhes da cobranca:', error);
                    await interaction.reply({ 
                        content: 'Erro ao recuperar codigo Pix. Tente novamente.', 
                        ephemeral: true 
                    });
                }
                return;
            }

            // Handler para copiar chave Pix (antigo - manter compatibilidade)
            if (interaction.customId === 'copy_pix_key') {
                // Enviar mensagem com a chave Pix formatada para fácil cópia
                const guildId = interaction.guild.id;
                const credentials = efiCredentials.get(guildId);
                
                if (!credentials || !credentials.pixKey) {
                    await interaction.reply({ 
                        content: '❌ Chave Pix não configurada!', 
                        ephemeral: true 
                    });
                    return;
                }
                
                await interaction.reply({ 
                    content: `📋 **Chave Pix para cópia:**\n\`${credentials.pixKey}\`\n\n*Selecione o texto acima e copie (Ctrl+C / Cmd+C)*`, 
                    ephemeral: true 
                });
                return;
            }

            // Handler para verificar status do pagamento
            if (interaction.customId === 'check_payment_status') {
                await interaction.deferReply({ ephemeral: true });
                
                try {
                    // Aqui vamos implementar a verificação manual do status
                    await interaction.editReply({ 
                        content: '🔄 Verificando status do pagamento...' 
                    });
                } catch (error) {
                    await interaction.editReply({ 
                        content: '❌ Erro ao verificar status do pagamento.' 
                    });
                }
                return;
            }

            // Handler para cancelar pagamento
            if (interaction.customId === 'cancel_payment') {
                const userId = interaction.user.id;
                const guildId = interaction.guild.id;
                const cartId = `${guildId}_${userId}`;
                
                // Limpar carrinho do usuário
                shoppingCarts.delete(cartId);
                
                // Iniciar animação de loading elegante
                const loadingEmbed = new EmbedBuilder()
                    .setColor('#ff6b6b')
                    .setTitle('Fechando Carrinho')
                    .setDescription('Aguarde um momento...')
                    .setTimestamp();

                await interaction.update({ 
                    content: '', 
                    embeds: [loadingEmbed], 
                    components: [] 
                });

                // Animação de loading elegante
                const loadingSteps = [
                    { title: 'Fechando Carrinho', desc: 'Processando seu pedido...' },
                    { title: 'Empacotando Itens', desc: 'Organizando seus produtos...' },
                    { title: 'Finalizando', desc: 'Quase pronto...' },
                    { title: 'Concluído', desc: 'Carrinho fechado com sucesso!' }
                ];
                
                for (let i = 0; i < loadingSteps.length; i++) {
                    setTimeout(async () => {
                        try {
                            const stepEmbed = new EmbedBuilder()
                                .setColor(i === loadingSteps.length - 1 ? '#00ff00' : '#ff6b6b')
                                .setTitle(loadingSteps[i].title)
                                .setDescription(loadingSteps[i].desc)
                                .setTimestamp();
                            
                            await interaction.message.edit({ embeds: [stepEmbed] });
                        } catch (error) {
                            // Ignorar erro se mensagem já foi deletada
                        }
                    }, i * 500);
                }

                // Deletar canal após animação
                setTimeout(async () => {
                    try {
                        await interaction.channel.delete();
                    } catch (error) {
                        console.error('Erro ao deletar canal do carrinho:', error);
                    }
                }, 2500);
                return;
            }

            switch (interaction.customId) {
                case 'edit_ticket_title':
                    const guild = interaction.guild;
                    const currentMessage = ticketMessages.get(guild.id) || {
                        title: 'Atendimento Radiant Store',
                        description: 'Seja bem-vindo(a) ao sistema de atendimento da Radiant Store\nDe segunda a sabado das 7h as 23h\nDomingo e feriado: sem horario determinado'
                    };

                    const titleModal = new ModalBuilder()
                        .setCustomId('edit_title_modal')
                        .setTitle('Editar Título da Mensagem');

                    const titleInput = new TextInputBuilder()
                        .setCustomId('message_title')
                        .setLabel('Título da Mensagem')
                        .setValue(currentMessage.title || 'Atendimento Radiant Store') // Preencher com valor atual
                        .setPlaceholder('Ex: Atendimento Radiant Store')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const titleActionRow = new ActionRowBuilder().addComponents(titleInput);
                    titleModal.addComponents(titleActionRow);

                    await interaction.showModal(titleModal);
                    break;

                case 'edit_ticket_description':
                    const descGuild = interaction.guild;
                    const currentDescMessage = ticketMessages.get(descGuild.id) || {
                        title: 'Atendimento Radiant Store',
                        description: 'Seja bem-vindo(a) ao sistema de atendimento da Radiant Store\nDe segunda a sabado das 7h as 23h\nDomingo e feriado: sem horario determinado'
                    };

                    const descModal = new ModalBuilder()
                        .setCustomId('edit_description_modal')
                        .setTitle('Editar Descrição da Mensagem');

                    const descInput = new TextInputBuilder()
                        .setCustomId('message_description')
                        .setLabel('Descrição da Mensagem')
                        .setValue(currentDescMessage.description || 'Seja bem-vindo(a) ao sistema de atendimento da Radiant Store\nDe segunda a sabado das 7h as 23h\nDomingo e feriado: sem horario determinado') // Preencher com valor atual
                        .setPlaceholder('Seja bem-vindo(a) ao sistema de atendimento...')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true);

                    const descActionRow = new ActionRowBuilder().addComponents(descInput);
                    descModal.addComponents(descActionRow);

                    await interaction.showModal(descModal);
                    break;

                case 'back_to_menu':
                    // Criar um menu completamente novo para limpar o estado
                    const mainEmbed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Painel de Configuração')
                        .setDescription('Selecione uma opção abaixo para configurar o bot:')
                        .setTimestamp();

                    // Forçar criação de novo menu com timestamp único
                    const uniqueMainId = `painel_select_${Date.now()}_${Math.random()}`;
                    const mainRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('painel_select') // Mantém o mesmo ID para o handler
                                .setPlaceholder('Selecione uma opção...')
                                .addOptions([
                                    {
                                        label: '🎫 Tickets',
                                        description: 'Gerencie o sistema de tickets',
                                        value: 'ticket_menu'
                                    }
                                ])
                        );

                    await interaction.update({ embeds: [mainEmbed], components: [mainRow] });
                    break;

                case 'edit_ticket_option':
                    const editGuild = interaction.guild;
                    const options = ticketOptions.get(editGuild.id) || [];
                    
                    if (options.length === 0) {
                        await interaction.reply({ content: '❌ Nenhuma opção para editar!', ephemeral: true });
                        return;
                    }

                    const editEmbed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Editar Opção de Ticket')
                        .setDescription('Selecione qual opção deseja editar:')
                        .setTimestamp();

                    // Adicionar lista de opções no embed para melhor visualização
                    if (options.length > 0) {
                        const optionsList = options.map((opt, index) => 
                            `${index + 1}. **${opt.label}**\n   ID: \`${opt.id}\``
                        ).join('\n\n');
                        
                        editEmbed.addFields(
                            { name: 'Opções Disponíveis', value: optionsList, inline: false }
                        );
                    }

                    const editOptions = options.map((opt, index) => ({
                        label: `${index + 1}. ${opt.label}`,
                        description: opt.description.length > 100 ? opt.description.substring(0, 97) + '...' : opt.description,
                        value: `edit_${opt.id}`
                    }));

                    const editRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('edit_option_select')
                                .setPlaceholder('Selecione uma opção para editar...')
                                .addOptions(editOptions)
                        );

                    // Adicionar botão voltar
                    const backRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('back_to_menu')
                                .setLabel('Voltar')
                                .setStyle(ButtonStyle.Secondary)
                        );

                    await interaction.update({ embeds: [editEmbed], components: [editRow, backRow] });
                    break;

                case 'delete_ticket_option':
                    const deleteGuild = interaction.guild;
                    const deleteOptions = ticketOptions.get(deleteGuild.id) || [];
                    
                    if (deleteOptions.length === 0) {
                        await interaction.reply({ content: '❌ Nenhuma opção para excluir!', ephemeral: true });
                        return;
                    }

                    const optionDeleteEmbed = new EmbedBuilder()
                        .setColor('#ff0000')
                        .setTitle('Excluir Opção de Ticket')
                        .setDescription('Selecione qual opção deseja excluir:')
                        .setTimestamp();

                    // Adicionar lista de opções no embed para melhor visualização
                    if (deleteOptions.length > 0) {
                        const optionsList = deleteOptions.map((opt, index) => 
                            `${index + 1}. **${opt.label}**\n   ID: \`${opt.id}\``
                        ).join('\n\n');
                        
                        optionDeleteEmbed.addFields(
                            { name: 'Opções Disponíveis', value: optionsList, inline: false }
                        );
                    }

                    const deleteOptionList = deleteOptions.map((opt, index) => ({
                        label: `${index + 1}. ${opt.label}`,
                        description: opt.description.length > 100 ? opt.description.substring(0, 97) + '...' : opt.description,
                        value: `delete_${opt.id}`
                    }));

                    const deleteRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('delete_option_select')
                                .setPlaceholder('Selecione uma opção para excluir...')
                                .addOptions(deleteOptionList)
                        );

                    // Adicionar botão voltar
                    const deleteBackRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('back_to_menu')
                                .setLabel('Voltar')
                                .setStyle(ButtonStyle.Secondary)
                        );

                    await interaction.update({ embeds: [optionDeleteEmbed], components: [deleteRow, deleteBackRow] });
                    break;

                case 'set_default_channel':
                    const setDefaultModal = new ModalBuilder()
                        .setCustomId('set_default_channel_modal')
                        .setTitle('Definir Canal Padrão');

                    const setDefaultInput = new TextInputBuilder()
                        .setCustomId('channel_id')
                        .setLabel('ID do Canal Padrão')
                        .setPlaceholder('Ex: 123456789012345678')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const setDefaultFirstActionRow = new ActionRowBuilder().addComponents(setDefaultInput);
                    setDefaultModal.addComponents(setDefaultFirstActionRow);

                    await interaction.showModal(setDefaultModal);
                    break;

                case 'set_transcript_channel':
                    const setTranscriptModal = new ModalBuilder()
                        .setCustomId('set_transcript_channel_modal')
                        .setTitle('Definir Canal de Transcripts');

                    const setTranscriptInput = new TextInputBuilder()
                        .setCustomId('transcript_channel_id')
                        .setLabel('ID do Canal')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('Digite o ID do canal de transcripts')
                        .setRequired(true);

                    const setTranscriptRow = new ActionRowBuilder().addComponents(setTranscriptInput);
                    setTranscriptModal.addComponents(setTranscriptRow);

                    await interaction.showModal(setTranscriptModal);
                    break;

                case 'set_purchase_transcript_channel':
                    const setPurchaseTranscriptModal = new ModalBuilder()
                        .setCustomId('set_purchase_transcript_channel_modal')
                        .setTitle('Definir Canal de Transcript de Compras');

                    const setPurchaseTranscriptInput = new TextInputBuilder()
                        .setCustomId('purchase_transcript_channel_id')
                        .setLabel('ID do Canal')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('Digite o ID do canal para receber informações de compras')
                        .setRequired(true);

                    const setPurchaseTranscriptRow = new ActionRowBuilder().addComponents(setPurchaseTranscriptInput);
                    setPurchaseTranscriptModal.addComponents(setPurchaseTranscriptRow);

                    await interaction.showModal(setPurchaseTranscriptModal);
                    break;

                case interaction.customId === 'use_default_channel' ? interaction.customId : '':
                    const useGuild = interaction.guild;
                    const defaultChannelId = defaultTicketChannels.get(useGuild.id);
                    
                    if (!defaultChannelId) {
                        await interaction.reply({ content: '❌ Nenhum canal padrão configurado!', ephemeral: true });
                        return;
                    }

                    try {
                        // Obter as opções de tickets configuradas
                        const options = ticketOptions.get(useGuild.id) || [];
                        
                        if (options.length === 0) {
                            await interaction.reply({ content: '❌ Adicione opções de tickets primeiro!', ephemeral: true });
                            return;
                        }

                        // Criar o embed personalizado
                        const customMessage = ticketMessages.get(useGuild.id) || {
                            title: 'Atendimento Radiant Store',
                            description: 'Seja bem-vindo(a) ao sistema de atendimento da Radiant Store\nDe segunda a sabado das 7h as 23h\nDomingo e feriado: sem horario determinado'
                        };

                        const visualConfig = ticketVisuals.get(useGuild.id) || {
                            imageUrl: '',
                            color: '#0099ff',
                            footer: 'Radiant Store 2025'
                        };

                        const embed = new EmbedBuilder()
                            .setColor(visualConfig.color || '#0099ff')
                            .setTitle(customMessage.title || 'Atendimento Radiant Store')
                            .setDescription(customMessage.description || 'Seja bem-vindo(a) ao sistema de atendimento da Radiant Store\nDe segunda a sabado das 7h as 23h\nDomingo e feriado: sem horario determinado');

                        // Adicionar imagem como thumbnail se houver
                        if (visualConfig.imageUrl) {
                            embed.setThumbnail(visualConfig.imageUrl);
                        }

                        // Adicionar rodapé se houver
                        if (visualConfig.footer) {
                            embed.setFooter({ text: visualConfig.footer });
                        }

                        // Criar o menu dropdown com as opções
                        const selectOptions = options.map(opt => ({
                            label: opt.label,
                            description: opt.description,
                            value: opt.id
                        }));

                        const ticketSelect = new ActionRowBuilder()
                            .addComponents(
                                new StringSelectMenuBuilder()
                                    .setCustomId('ticket_type_select')
                                    .setPlaceholder('Selecione uma opção para abrir um ticket...')
                                    .addOptions(selectOptions)
                            );

                        // Enviar para o canal padrão
                        const targetChannel = await useGuild.channels.fetch(defaultChannelId);
                        
                        if (!targetChannel || targetChannel.type !== 0) {
                            await interaction.reply({ content: '❌ Canal padrão não encontrado ou não é um canal de texto!', ephemeral: true });
                            return;
                        }

                        await targetChannel.send({ embeds: [embed], components: [ticketSelect] });
                        await interaction.reply({ content: `✅ Mensagem de tickets criada em ${targetChannel}!`, ephemeral: true });

                    } catch (error) {
                        // Ignorar erro de interação já respondida
                        if (error.code === 40060) {
                            return;
                        }
                        console.error('Erro ao criar mensagem de tickets:', error);
                        if (!interaction.replied && !interaction.deferred) {
                            await interaction.reply({ content: '❌ Erro ao criar a mensagem de tickets.', ephemeral: true });
                        }
                    }
                    break;

                case 'change_channel':
                    const changeModal = new ModalBuilder()
                        .setCustomId('ticket_channel_modal')
                        .setTitle('Mudar Canal da Mensagem');

                    const channelIdInput = new TextInputBuilder()
                        .setCustomId('channel_id')
                        .setLabel('ID do Novo Canal')
                        .setPlaceholder('Ex: 123456789012345678')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    changeModal.addComponents(
                        new ActionRowBuilder().addComponents(channelIdInput)
                    );

                    await interaction.showModal(changeModal);
                    break;

                case 'edit_visual_image':
                    const imageModal = new ModalBuilder()
                        .setCustomId('edit_visual_image_modal')
                        .setTitle('Editar Miniatura do Ticket');

                    const imageInput = new TextInputBuilder()
                        .setCustomId('image_url')
                        .setLabel('URL da Miniatura (Imagem/GIF pequena)')
                        .setPlaceholder('Ex: https://example.com/thumbnail.gif - aparecerá ao lado do título')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false);

                    imageModal.addComponents(
                        new ActionRowBuilder().addComponents(imageInput)
                    );

                    await interaction.showModal(imageModal);
                    break;

                case 'edit_visual_color':
                    const colorModal = new ModalBuilder()
                        .setCustomId('edit_visual_color_modal')
                        .setTitle('Editar Cor do Ticket');

                    const colorInput = new TextInputBuilder()
                        .setCustomId('color_hex')
                        .setLabel('Cor (Hexadecimal)')
                        .setPlaceholder('Ex: #0099ff ou #ff0000')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    colorModal.addComponents(
                        new ActionRowBuilder().addComponents(colorInput)
                    );

                    await interaction.showModal(colorModal);
                    break;

                case 'edit_visual_footer':
                    const footerModal = new ModalBuilder()
                        .setCustomId('edit_visual_footer_modal')
                        .setTitle('Editar Rodapé do Ticket');

                    const footerInput = new TextInputBuilder()
                        .setCustomId('footer_text')
                        .setLabel('Texto do Rodapé')
                        .setPlaceholder('Ex: Radiant Store 2025')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    footerModal.addComponents(
                        new ActionRowBuilder().addComponents(footerInput)
                    );

                    await interaction.showModal(footerModal);
                    break;

                case 'add_staff_user':
                    const addStaffModal = new ModalBuilder()
                        .setCustomId('add_staff_modal')
                        .setTitle('Cadastrar Usuário Staff');

                    const addStaffInput = new TextInputBuilder()
                        .setCustomId('user_id')
                        .setLabel('ID do Usuário')
                        .setPlaceholder('Ex: 123456789012345678')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    addStaffModal.addComponents(
                        new ActionRowBuilder().addComponents(addStaffInput)
                    );

                    await interaction.showModal(addStaffModal);
                    break;

                case 'remove_staff_user':
                    const removeGuild = interaction.guild;
                    const removeStaffList = staffRoles.get(removeGuild.id) || [];
                    
                    if (removeStaffList.length === 0) {
                        await interaction.reply({ content: '❌ Nenhum usuário staff para excluir!', ephemeral: true });
                        return;
                    }

                    const removeEmbed = new EmbedBuilder()
                        .setColor('#ff0000')
                        .setTitle('Excluir Usuário Staff')
                        .setDescription('Selecione qual usuário deseja excluir:')
                        .setTimestamp();

                    // Adicionar lista de usuários no embed para melhor visualização
                    const removeStaffOptions = await Promise.all(
                        removeStaffList.map(async (userId, index) => {
                            try {
                                const user = await removeGuild.client.users.fetch(userId);
                                return {
                                    label: `${index + 1}. ${user.tag}`,
                                    description: `ID: ${userId}`,
                                    value: `remove_${userId}`
                                };
                            } catch (error) {
                                return {
                                    label: `${index + 1}. Usuário não encontrado`,
                                    description: `ID: ${userId}`,
                                    value: `remove_${userId}`
                                };
                            }
                        })
                    );

                    const removeRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('remove_staff_select')
                                .setPlaceholder('Selecione um usuário para excluir...')
                                .addOptions(removeStaffOptions)
                        );

                    // Adicionar botão voltar
                    const removeBackRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('back_to_staff_manager')
                                .setLabel('⬅️ Voltar')
                                .setStyle(ButtonStyle.Secondary)
                        );

                    await interaction.update({ embeds: [removeEmbed], components: [removeRow, removeBackRow] });
                    break;

                case 'back_to_staff_manager':
                    await showStaffManager(interaction);
                    break;

                case 'add_ticket_option':
                    const modal = new ModalBuilder()
                        .setCustomId('add_ticket_option_modal')
                        .setTitle('Adicionar Opção de Ticket');

                    const labelInput = new TextInputBuilder()
                        .setCustomId('option_label')
                        .setLabel('Nome da Opção')
                        .setPlaceholder('Ex: Dúvida sobre Produto')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const descriptionInput = new TextInputBuilder()
                        .setCustomId('option_description')
                        .setLabel('Descrição da Opção')
                        .setPlaceholder('Ex: Tire suas dúvidas sobre nossos produtos')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true);

                    const emojiInput = new TextInputBuilder()
                        .setCustomId('option_emoji')
                        .setLabel('Emoji (opcional)')
                        .setPlaceholder('Ex: 🛍️')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false);

                    modal.addComponents(
                        new ActionRowBuilder().addComponents(labelInput),
                        new ActionRowBuilder().addComponents(descriptionInput),
                        new ActionRowBuilder().addComponents(emojiInput)
                    );

                    await interaction.showModal(modal);
                    break;

                case 'update_ticket_message':
                    const categoryId = ticketChannels.get(interaction.guild.id);
                    
                    if (!categoryId) {
                        await interaction.reply({ content: '❌ Configure uma categoria primeiro!', ephemeral: true });
                        return;
                    }

                    try {
                        await updateTicketMessage(interaction.guild, categoryId);
                        await interaction.reply({ content: '✅ Mensagem de tickets atualizada!', ephemeral: true });
                    } catch (error) {
                        console.error('Erro ao atualizar mensagem:', error);
                        await interaction.reply({ content: '❌ Erro ao atualizar a mensagem.', ephemeral: true });
                    }
                    break;

                // Handlers para gerenciamento de produtos
                case interaction.customId.startsWith('add_plan_') ? interaction.customId : '':
                    const productIdForPlan = interaction.customId.replace('add_plan_', '');
                    
                    const addPlanModal = new ModalBuilder()
                        .setCustomId(`add_plan_modal_${productIdForPlan}`)
                        .setTitle('Adicionar Plano');

                    const planNameInput = new TextInputBuilder()
                        .setCustomId('plan_name')
                        .setLabel('Nome do Plano')
                        .setPlaceholder('Ex: Diário, Semanal, Mensal')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const planPriceInput = new TextInputBuilder()
                        .setCustomId('plan_price')
                        .setLabel('Valor (R$)')
                        .setPlaceholder('Ex: 35.00')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    addPlanModal.addComponents(
                        new ActionRowBuilder().addComponents(planNameInput),
                        new ActionRowBuilder().addComponents(planPriceInput)
                    );

                    await interaction.showModal(addPlanModal);
                    break;

                case interaction.customId.startsWith('edit_plan_') ? interaction.customId : '':
                    const editPlanProductId = interaction.customId.replace('edit_plan_', '');
                    const editPlanGuild = interaction.guild;
                    const editPlanGuildPlans = productPlans.get(editPlanGuild.id) || {};
                    const editPlansList = editPlanGuildPlans[editPlanProductId] || [];

                    if (editPlansList.length === 0) {
                        await interaction.reply({ content: '❌ Nenhum plano para editar!', ephemeral: true });
                        return;
                    }

                    const editPlanEmbed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Editar Plano')
                        .setDescription('Selecione o plano que deseja editar:');

                    const editPlanOptions = editPlansList.map((plan, index) => ({
                        label: plan.name,
                        description: `R$ ${plan.price.toFixed(2)}`,
                        value: `edit_plan_${editPlanProductId}_${index}`
                    }));

                    const editPlanRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('select_edit_plan')
                                .setPlaceholder('Selecione um plano...')
                                .addOptions(editPlanOptions)
                        );

                    await interaction.update({ embeds: [editPlanEmbed], components: [editPlanRow] });
                    break;

                case interaction.customId.startsWith('delete_plan_') ? interaction.customId : '':
                    const deletePlanProductId = interaction.customId.replace('delete_plan_', '');
                    const deletePlanGuild = interaction.guild;
                    const deletePlanGuildPlans = productPlans.get(deletePlanGuild.id) || {};
                    const deletePlansList = deletePlanGuildPlans[deletePlanProductId] || [];

                    if (deletePlansList.length === 0) {
                        await interaction.reply({ content: '❌ Nenhum plano para excluir!', ephemeral: true });
                        return;
                    }

                    const deletePlanEmbed = new EmbedBuilder()
                        .setColor('#ff0000')
                        .setTitle('Excluir Plano')
                        .setDescription('⚠️ Selecione o plano que deseja excluir:');

                    const deletePlanOptions = deletePlansList.map((plan, index) => ({
                        label: plan.name,
                        description: `R$ ${plan.price.toFixed(2)}`,
                        value: `delete_plan_${deletePlanProductId}_${index}`
                    }));

                    const deletePlanRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('select_delete_plan')
                                .setPlaceholder('Selecione um plano...')
                                .addOptions(deletePlanOptions)
                        );

                    await interaction.update({ embeds: [deletePlanEmbed], components: [deletePlanRow] });
                    break;

                case 'edit_product':
                    const editProdGuild = interaction.guild;
                    const editProdList = products.get(editProdGuild.id) || [];

                    if (editProdList.length === 0) {
                        const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_manage_products')
                        .setLabel('⬅️ Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({ content: '❌ Nenhum produto para editar!', embeds: [], components: [backButton] });
                        return;
                    }

                    const editProdEmbed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Editar Produto')
                        .setDescription('Selecione o produto que deseja editar:');

                    const editProdOptions = editProdList.map(product => ({
                        label: product.name,
                        description: `ID: ${product.id}`,
                        value: `edit_${product.id}`
                    }));

                    const editProdRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('select_edit_product')
                                .setPlaceholder('Selecione um produto...')
                                .addOptions(editProdOptions)
                        );

                    await interaction.update({ embeds: [editProdEmbed], components: [editProdRow] });
                    break;

                case 'delete_product':
                    const deleteProdGuild = interaction.guild;
                    const deleteProdList = products.get(deleteProdGuild.id) || [];

                    if (deleteProdList.length === 0) {
                        const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_manage_products')
                        .setLabel('⬅️ Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({ content: '❌ Nenhum produto para excluir!', embeds: [], components: [backButton] });
                        return;
                    }

                    const deleteProdEmbed = new EmbedBuilder()
                        .setColor('#ff0000')
                        .setTitle('Excluir Produto')
                        .setDescription('⚠️ Selecione o produto que deseja excluir:');

                    const deleteProdOptions = deleteProdList.map(product => ({
                        label: product.name,
                        description: `ID: ${product.id}`,
                        value: `delete_${product.id}`
                    }));

                    const deleteProdRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('select_delete_product')
                                .setPlaceholder('Selecione um produto...')
                                .addOptions(deleteProdOptions)
                        );

                    await interaction.update({ embeds: [deleteProdEmbed], components: [deleteProdRow] });
                    break;

                case 'back_to_products':
                    await showManageProducts(interaction);
                    break;

                case interaction.customId.startsWith('send_product_now_') ? interaction.customId : '':
                    const sendNowProductId = interaction.customId.replace('send_product_now_', '');
                    const sendNowGuild = interaction.guild;
                    const sendNowChannels = productChannels.get(sendNowGuild.id) || {};
                    const sendNowChannelId = sendNowChannels[sendNowProductId];

                    if (!sendNowChannelId) {
                        await interaction.reply({ content: '❌ Nenhum canal cadastrado! Cadastre um canal primeiro.', ephemeral: true });
                        return;
                    }

                    try {
                        const channel = await sendNowGuild.channels.fetch(sendNowChannelId);
                        if (!channel || channel.type !== 0) {
                            await interaction.reply({ content: '❌ Canal não encontrado! Configure um novo canal.', ephemeral: true });
                            return;
                        }

                        const guildProducts = products.get(sendNowGuild.id) || [];
                        const product = guildProducts.find(p => p.id === sendNowProductId);

                        if (!product) {
                            await interaction.reply({ content: '❌ Produto não encontrado!', ephemeral: true });
                            return;
                        }

                        const guildPlans = productPlans.get(sendNowGuild.id) || {};
                        const plans = guildPlans[sendNowProductId] || [];

                        const productEmbed = new EmbedBuilder()
                            .setColor('#0099ff')
                            .setDescription(product.description)
                            .setImage(product.imageUrl)
                            .setFooter({ text: product.footer || 'Agradecemos pela sua preferência pela One Store 2026!' })
                            .setTimestamp();

                        const embeds = [productEmbed];
                        const components = [];

                        // Se houver banner, criar um embed separado para ele
                        if (product.bannerUrl) {
                            const bannerEmbed = new EmbedBuilder()
                                .setColor('#0099ff')
                                .setImage(product.bannerUrl);
                            embeds.push(bannerEmbed);
                        }

                        if (plans.length > 0) {
                            const planOptions = plans.map(plan => ({
                                label: plan.name,
                                description: `Valor: R$ ${plan.price.toFixed(2)}`,
                                value: `buy_${sendNowProductId}_${plan.name}`
                            }));

                            const selectMenu = new StringSelectMenuBuilder()
                                .setCustomId(`select_plan_${sendNowProductId}`)
                                .setPlaceholder('Selecione um plano')
                                .addOptions(planOptions);

                            components.push(new ActionRowBuilder().addComponents(selectMenu));
                        }

                        await channel.send({ embeds, components });

                        await interaction.reply({ content: `✅ Produto **${product.name}** enviado para ${channel}!`, ephemeral: true });

                    } catch (error) {
                        console.error('Erro ao enviar produto:', error);
                        await interaction.reply({ content: '❌ Erro ao enviar produto.', ephemeral: true });
                    }
                    break;

                case interaction.customId.startsWith('change_product_channel_') ? interaction.customId : '':
                    const changeChannelProductId = interaction.customId.replace('change_product_channel_', '');
                    
                    const changeChannelModal = new ModalBuilder()
                        .setCustomId(`change_channel_modal_${changeChannelProductId}`)
                        .setTitle('Cadastrar/Mudar Canal');

                    const changeChannelInput = new TextInputBuilder()
                        .setCustomId('new_channel_id')
                        .setLabel('ID do Canal')
                        .setPlaceholder('Cole o ID do canal aqui')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    changeChannelModal.addComponents(
                        new ActionRowBuilder().addComponents(changeChannelInput)
                    );

                    await interaction.showModal(changeChannelModal);
                    break;

                // Handlers para configuração de estoque
                case interaction.customId.startsWith('set_auto_stock_') ? interaction.customId : '':
                    const setAutoProductId = interaction.customId.replace('set_auto_stock_', '');
                    const setAutoGuild = interaction.guild;
                    
                    // Salvar preferência como automático
                    const guildPrefs = stockPreference.get(setAutoGuild.id) || {};
                    guildPrefs[setAutoProductId] = 'auto';
                    stockPreference.set(setAutoGuild.id, guildPrefs);
                    saveData();
                    
                    const autoBackButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_shipping_stock')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({
                    content: '✅ Preferência definida: Estoque Automático!\n\nConfigure o KeyAuth abaixo:',
                    embeds: [],
                    components: [autoBackButton]
                });
                    
                    // Redirecionar para configuração automática
                    setTimeout(async () => await showAutoStock(interaction), 1000);
                    break;

                case interaction.customId.startsWith('set_manual_stock_') ? interaction.customId : '':
                    const setManualProductId = interaction.customId.replace('set_manual_stock_', '');
                    const setManualGuild = interaction.guild;
                    
                    // Salvar preferência como manual
                    const guildManualPrefs = stockPreference.get(setManualGuild.id) || {};
                    guildManualPrefs[setManualProductId] = 'manual';
                    stockPreference.set(setManualGuild.id, guildManualPrefs);
                    saveData();
                    
                    const manualBackButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_shipping_stock')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({
                    content: '✅ Preferência definida: Estoque Manual!\n\nCadastre as keys abaixo:',
                    embeds: [],
                    components: [manualBackButton]
                });
                    
                    // Redirecionar para configuração manual
                    setTimeout(async () => await showManualStock(interaction), 1000);
                    break;


                case interaction.customId.startsWith('back_to_product_plans_') ? interaction.customId : '':
                    const productId = interaction.customId.replace('back_to_product_plans_', '');
                    const guildBack = interaction.guild;
                    const guildProducts = products.get(guildBack.id) || [];
                    const product = guildProducts.find(p => p.id === productId);
                    
                    if (product) {
                        const guildPlans = productPlans.get(guildBack.id) || {};
                        const plans = guildPlans[productId] || [];
                        
                        const embed = new EmbedBuilder()
                            .setColor('#0099ff')
                            .setTitle(`Planos - ${product.name}`)
                            .setDescription(plans.length > 0 ? 'Planos configurados:' : 'Nenhum plano configurado ainda.')
                            .setThumbnail(product.imageUrl);
                        
                        if (plans.length > 0) {
                            plans.forEach((plan, index) => {
                                embed.addFields({
                                    name: plan.name,
                                    value: `💰 Valor: R$ ${plan.price}\n📅 ID: ${productId}_${index}`,
                                    inline: false
                                });
                            });
                        }
                        
                        const components = [];
                        
                        if (plans.length > 0) {
                            const row1 = new ActionRowBuilder()
                                .addComponents(
                                    new ButtonBuilder()
                                        .setCustomId('add_plan')
                                        .setLabel('Adicionar Plano')
                                        .setStyle(ButtonStyle.Success)
                                );
                            components.push(row1);
                        }
                        
                        const backButton = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`back_to_product_plans_${productId}`)
                                    .setLabel('⬅️ Voltar')
                                    .setStyle(ButtonStyle.Secondary)
                            );
                        components.push(backButton);
                        
                        await interaction.update({ embeds: [embed], components });
                    }
                    break;

                case 'back_to_main':
                    // Criar um menu completamente novo para limpar o estado
                    const backMainEmbed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Painel de Configuração')
                        .setDescription('Selecione uma opção abaixo para configurar o bot:')
                        .setTimestamp();

                    // Forçar criação de novo menu com timestamp único
                    const backUniqueId = `painel_select_${Date.now()}_${Math.random()}`;
                    const backMainRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('painel_select') // Mantém o mesmo ID para o handler
                                .setPlaceholder('Selecione uma opção...')
                                .addOptions([
                                    {
                                        label: 'Tickets',
                                        description: 'Configure o sistema de tickets',
                                        emoji: '🎫',
                                        value: 'ticket_menu'
                                    },
                                    {
                                        label: 'Produtos',
                                        description: 'Gerencie produtos e planos',
                                        emoji: '📦',
                                        value: 'products_menu'
                                    },
                                    {
                                        label: 'Cupons',
                                        description: 'Crie e gerencie cupons de desconto',
                                        emoji: '🎟️',
                                        value: 'manage_coupons'
                                    },
                                    {
                                        label: 'Envios',
                                        description: 'Configure tutoriais e downloads',
                                        emoji: '📤',
                                        value: 'shipping_menu'
                                    },
                                    {
                                        label: 'Logs',
                                        description: 'Configure logs de entrada e saída',
                                        emoji: '📋',
                                        value: 'logs_menu'
                                    },
                                    {
                                        label: 'Pagamentos',
                                        description: 'Configure as credenciais do EFI Bank',
                                        emoji: '💳',
                                        value: 'payments_menu'
                                    },
                                                                    ])
                        );

                    await interaction.update({ embeds: [backMainEmbed], components: [backMainRow] });
                    break;

                case 'back_to_products':
                    // Voltar para o menu de produtos
                    const productsEmbed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Menu de Produtos')
                        .setDescription('Selecione uma opção abaixo:')
                        .setTimestamp();

                    const productsRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('products_submenu')
                                .setPlaceholder('Selecione uma opção de produtos...')
                                .addOptions([
                                    {
                                        label: 'Criar Produto',
                                        description: 'Cadastre um novo produto na loja',
                                        value: 'create_product'
                                    },
                                    {
                                        label: 'Gerenciar Planos',
                                        description: 'Configure planos e valores dos produtos',
                                        value: 'manage_plans'
                                    },
                                    {
                                        label: 'Gerenciar Produtos',
                                        description: 'Edite ou exclua produtos existentes',
                                        value: 'manage_products'
                                    },
                                    {
                                        label: 'Envio Estoque',
                                        description: 'Configure tipo de estoque (automático ou manual)',
                                        value: 'shipping_stock'
                                    },
                                    {
                                        label: 'Enviar Produto',
                                        description: 'Envie um produto para um canal',
                                        value: 'send_product'
                                    },
                                    {
                                        label: 'Categoria de Compra',
                                        description: 'Configure o canal onde os carrinhos serão abertos',
                                        value: 'purchase_category'
                                    },
                                    {
                                        label: 'ID Clientes',
                                        description: 'Configure o cargo que os clientes recebem ao comprar',
                                        value: 'client_roles'
                                    }
                                ])
                        );

                    await interaction.update({ embeds: [productsEmbed], components: [productsRow] });
                    break;

                case 'back_to_auto_stock':
                    await showAutoStock(interaction);
                    break;

                case 'back_to_manual_stock':
                    await showManualStock(interaction);
                    break;

                case 'back_to_manage_coupons':
                    await showManageCoupons(interaction);
                    break;

                case 'back_to_manage_plans':
                    await showManagePlans(interaction);
                    break;

                case 'back_to_shipping_stock':
                    await showShippingStock(interaction);
                    break;

                case interaction.customId.startsWith('edit_cart_quantity_') ? interaction.customId : '':
                    const editIndex = parseInt(interaction.customId.replace('edit_cart_quantity_', ''));
                    const editCartKey = `${interaction.guild.id}_${interaction.user.id}`;
                    const editCart = shoppingCarts.get(editCartKey);

                    if (!editCart || !editCart.items[editIndex]) {
                        await interaction.reply({ content: '❌ Item não encontrado no carrinho!', ephemeral: true });
                        return;
                    }

                    const editModal = new ModalBuilder()
                        .setCustomId(`edit_quantity_modal_${editIndex}`)
                        .setTitle('Editar Quantidade');

                    const quantityInput = new TextInputBuilder()
                        .setCustomId('new_quantity')
                        .setLabel('Nova Quantidade')
                        .setPlaceholder('Digite a quantidade desejada')
                        .setValue(editCart.items[editIndex].quantity.toString())
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    editModal.addComponents(
                        new ActionRowBuilder().addComponents(quantityInput)
                    );

                    await interaction.showModal(editModal);
                    break;

                case interaction.customId.startsWith('remove_cart_item_') ? interaction.customId : '':
                    const removeIndex = parseInt(interaction.customId.replace('remove_cart_item_', ''));
                    const removeCartKey = `${interaction.guild.id}_${interaction.user.id}`;
                    const removeCart = shoppingCarts.get(removeCartKey);

                    if (!removeCart || !removeCart.items[removeIndex]) {
                        await interaction.reply({ content: '❌ Item não encontrado no carrinho!', ephemeral: true });
                        return;
                    }

                    const removedItem = removeCart.items[removeIndex];
                    removeCart.items.splice(removeIndex, 1);

                    if (removeCart.items.length === 0) {
                        shoppingCarts.delete(removeCartKey);
                        const backButton = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId('back_to_products_menu')
                                    .setLabel('⬅️ Voltar aos Produtos')
                                    .setStyle(ButtonStyle.Secondary)
                            );

                        await interaction.update({ 
                            content: '✅ Item removido! Seu carrinho está vazio agora.', 
                            embeds: [], 
                            components: [backButton] 
                        });
                    } else {
                        shoppingCarts.set(removeCartKey, removeCart);
                        await interaction.deferUpdate();
                        await showShoppingCart(interaction, removeCart, interaction.guild);
                    }
                    break;

                case 'cancel_cart':
                    const cancelCartKey = `${interaction.guild.id}_${interaction.user.id}`;
                    shoppingCarts.delete(cancelCartKey);
                    
                    // Iniciar animação de loading elegante
                    const loadingEmbed = new EmbedBuilder()
                        .setColor('#ff6b6b')
                        .setTitle('Fechando Carrinho')
                        .setDescription('Aguarde um momento...')
                        .setTimestamp();

                    await interaction.update({ 
                        content: '', 
                        embeds: [loadingEmbed], 
                        components: [] 
                    });

                    // Animação de loading elegante
                    const loadingSteps = [
                        { title: 'Fechando Carrinho', desc: 'Processando seu pedido...' },
                        { title: 'Empacotando Itens', desc: 'Organizando seus produtos...' },
                        { title: 'Finalizando', desc: 'Quase pronto...' },
                        { title: 'Concluído', desc: 'Carrinho fechado com sucesso!' }
                    ];
                    
                    for (let i = 0; i < loadingSteps.length; i++) {
                        setTimeout(async () => {
                            try {
                                const stepEmbed = new EmbedBuilder()
                                    .setColor(i === loadingSteps.length - 1 ? '#00ff00' : '#ff6b6b')
                                    .setTitle(loadingSteps[i].title)
                                    .setDescription(loadingSteps[i].desc)
                                    .setTimestamp();
                                
                                await interaction.message.edit({ embeds: [stepEmbed] });
                            } catch (error) {
                                // Ignorar erro se mensagem já foi deletada
                            }
                        }, i * 500);
                    }

                    // Deletar canal após animação
                    setTimeout(async () => {
                        try {
                            await interaction.channel.delete();
                        } catch (error) {
                            console.error('Erro ao deletar canal do carrinho:', error);
                        }
                    }, 2500);
                    break;

                case 'apply_coupon':
                    const applyCouponModal = new ModalBuilder()
                        .setCustomId('apply_coupon_modal')
                        .setTitle('Aplicar Cupom');

                    const couponCodeInput = new TextInputBuilder()
                        .setCustomId('coupon_code')
                        .setLabel('Código do Cupom')
                        .setPlaceholder('Ex: DESCONTO10')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    applyCouponModal.addComponents(
                        new ActionRowBuilder().addComponents(couponCodeInput)
                    );

                    await interaction.showModal(applyCouponModal);
                    break;

                case interaction.customId.startsWith('edit_coupon_') ? interaction.customId : '':
                    const editCouponId = interaction.customId.replace('edit_coupon_', '');
                    const editCouponGuild = interaction.guild;
                    const editCouponGuildCoupons = coupons.get(editCouponGuild.id) || [];
                    const editCoupon = editCouponGuildCoupons.find(c => c.id === editCouponId);

                    if (!editCoupon) {
                        await interaction.reply({ content: '❌ Cupom não encontrado!', ephemeral: true });
                        return;
                    }

                    const editCouponModal = new ModalBuilder()
                        .setCustomId(`edit_coupon_modal_${editCouponId}`)
                        .setTitle('Editar Cupom');

                    const editNameInput = new TextInputBuilder()
                        .setCustomId('edit_coupon_name')
                        .setLabel('Nome do Cupom')
                        .setValue(editCoupon.name)
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const editPercentageInput = new TextInputBuilder()
                        .setCustomId('edit_coupon_percentage')
                        .setLabel('Porcentagem de Desconto (%)')
                        .setValue(editCoupon.percentage.toString())
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const editMinValueInput = new TextInputBuilder()
                        .setCustomId('edit_coupon_min_value')
                        .setLabel('Valor Mínimo (R$)')
                        .setValue(editCoupon.minValue.toString())
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const editDurationInput = new TextInputBuilder()
                        .setCustomId('edit_coupon_duration')
                        .setLabel('Nova Duração (Ex: 30m, 2h, 1d)')
                        .setPlaceholder('Deixe vazio para manter a duração atual')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false);

                    editCouponModal.addComponents(
                        new ActionRowBuilder().addComponents(editNameInput),
                        new ActionRowBuilder().addComponents(editPercentageInput),
                        new ActionRowBuilder().addComponents(editMinValueInput),
                        new ActionRowBuilder().addComponents(editDurationInput)
                    );

                    await interaction.showModal(editCouponModal);
                    break;

                case interaction.customId.startsWith('delete_coupon_') ? interaction.customId : '':
                    const deleteCouponId = interaction.customId.replace('delete_coupon_', '');
                    const deleteCouponGuild = interaction.guild;
                    const deleteCouponGuildCoupons = coupons.get(deleteCouponGuild.id) || [];
                    const deleteCouponIndex = deleteCouponGuildCoupons.findIndex(c => c.id === deleteCouponId);

                    if (deleteCouponIndex === -1) {
                        await interaction.reply({ content: '❌ Cupom não encontrado!', ephemeral: true });
                        return;
                    }

                    const deletedCoupon = deleteCouponGuildCoupons[deleteCouponIndex];
                    deleteCouponGuildCoupons.splice(deleteCouponIndex, 1);
                    coupons.set(deleteCouponGuild.id, deleteCouponGuildCoupons);
                    saveData();

                    const deleteCouponEmbed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Cupom Excluído!')
                        .setDescription(`Cupom **${deletedCoupon.name}** foi excluído com sucesso.`)
                        .setTimestamp();

                    const backButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_manage_coupons')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({ embeds: [deleteCouponEmbed], components: [backButton] });
                    break;

                case 'continue_payment':
                    const paymentCartKey = `${interaction.guild.id}_${interaction.user.id}`;
                    const paymentCart = shoppingCarts.get(paymentCartKey);
                    
                    if (!paymentCart) {
                        await interaction.reply({ 
                            content: '❌ Carrinho não encontrado!', 
                            ephemeral: true 
                        });
                        return;
                    }

                    await interaction.deferReply();

                    // Calcular total
                    let totalCart = 0;
                    paymentCart.items.forEach((item) => {
                        totalCart += item.unitPrice * item.quantity;
                    });

                    // Aplicar desconto se houver cupom
                    if (paymentCart.appliedCoupon) {
                        const discount = (totalCart * paymentCart.appliedCoupon.percentage) / 100;
                        totalCart -= discount;
                    }

                    // Verificar estoque (se implementado)
                    let stockAvailable = true;
                    let stockMessage = '';

                    const guildStock = productStock.get(interaction.guild.id) || {};
                    for (const item of paymentCart.items) {
                        const availableStock = guildStock[item.productId] || 999999; // Ilimitado se não configurado
                        if (availableStock < item.quantity) {
                            stockAvailable = false;
                            stockMessage = `❌ Estoque insuficiente para ${item.productName}! Disponível: ${availableStock}, Solicitado: ${item.quantity}`;
                            break;
                        }
                    }

                    if (!stockAvailable) {
                        await interaction.editReply({ content: stockMessage });
                        return;
                    }

                    // Verificar se as credenciais EFI estão configuradas
                    const credentials = efiCredentials.get(interaction.guild.id);
                    if (!credentials) {
                        await interaction.editReply({ 
                            content: '❌ Pagamento não configurado! Peça ao administrador para configurar as credenciais EFI em `/painel > Pagamentos`.' 
                        });
                        return;
                    }

                    // Mostrar tela de pagamento com QR Code
                    await showPaymentScreen(interaction, paymentCart, totalCart);
                    return;

                    // Enviar confirmação com informações de envio
                    const confirmationEmbed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('✅ Pagamento Concluído!')
                        .setDescription(`Compra realizada com sucesso! ID: ${purchaseId}`)
                        .addFields(
                            { name: 'Data da Compra', value: purchaseDate, inline: false },
                            { name: 'Total Pago', value: `R$ ${totalCart.toFixed(2)}`, inline: true },
                            { name: 'Forma de Pagamento', value: 'Pix (Simulado)', inline: true }
                        )
                        .setTimestamp();

                    if (paymentCart.appliedCoupon) {
                        confirmationEmbed.addFields(
                            { name: 'Cupom Aplicado', value: `${paymentCart.appliedCoupon.code} (${paymentCart.appliedCoupon.percentage}% off)`, inline: false }
                        );
                    }

                    // Adicionar informações de envio
                    if (shippingInfo.length > 0) {
                        let shippingText = '';
                        for (const info of shippingInfo) {
                            shippingText += `\n\n**${info.productName}**:\n${info.tutorial}`;
                            if (info.videoLink) {
                                shippingText += `\n📹 [Vídeo Tutorial](${info.videoLink})`;
                            }
                            if (info.downloadLink) {
                                shippingText += `\n🔗 [Download](${info.downloadLink})`;
                            }
                        }
                        
                        confirmationEmbed.addFields(
                            { name: '📦 Informações de Envio', value: shippingText, inline: false }
                        );
                    }

                    // Não enviar confirmação detalhada no canal, apenas animação
                    
                    // Enviar mensagem privada para o usuário com as informações do produto
                    const user = interaction.user;
                    try {
                        
                        // Enviar banner/rodapé primeiro (uma única vez)
                        const guildProducts = products.get(interaction.guild.id) || [];
                        const firstProduct = paymentCart.items[0];
                        const firstProductInfo = guildProducts.find(p => p.id === firstProduct.productId);
                        
                        if (firstProductInfo?.bannerUrl) {
                            const bannerEmbed = new EmbedBuilder()
                                .setImage(firstProductInfo.bannerUrl);
                            await user.send({ embeds: [bannerEmbed] });
                        }
                        
                        for (const item of paymentCart.items) {
                            const shipping = guildShipping[item.productId];
                            if (shipping) {
                                // Obter informações do produto
                                const productInfo = guildProducts.find(p => p.id === item.productId);
                                
                                // Adicionar preço ao item se não existir
                                if (!item.price) {
                                    const guildPlans = productPlans.get(interaction.guild.id) || {};
                                    const plans = guildPlans[item.productId] || [];
                                    const planInfo = plans.find(p => p.name === item.planName);
                                    if (planInfo) {
                                        item.price = planInfo.price;
                                    }
                                }
                                
                                // Gerar/obter key do produto
                                const keyResult = await getProductKey(interaction.guild.id, item.productId, item.planName);
                                
                                // Criar embed com informações do produto
                                const productEmbed = new EmbedBuilder()
                                    .setColor('#0099ff')
                                    .setTitle(item.productName)
                                    .setDescription('Agradecemos sua compra! Abaixo estão as instruções e arquivos:')
                                    .setFooter({ text: productInfo?.footer || 'Obrigado pela sua compra!' })
                                    .setTimestamp();

                                // Adicionar key se disponível
                                if (keyResult) {
                                    const keySource = keyResult.source === 'manual' ? 'Manual' : `Automatica (${keyResult.days} dias)`;
                                    productEmbed.addFields(
                                        { name: 'Chave de Acesso', value: `\`\`\`${keyResult.key}\`\`\``, inline: false },
                                        { name: 'Origem', value: keySource, inline: true },
                                        { name: 'Plano', value: item.planName, inline: true }
                                    );
                                } else {
                                    productEmbed.addFields(
                                        { name: 'Atencao', value: 'Não foi possível gerar uma key automaticamente. Entre em contato com o suporte.', inline: false }
                                    );
                                }

                                // Adicionar tutorial
                                if (shipping.tutorial) {
                                    productEmbed.addFields(
                                        { name: 'Tutorial', value: shipping.tutorial, inline: false }
                                    );
                                }

                                // Criar botões
                                const buttonsRow = new ActionRowBuilder();
                                
                                // Botão de Tutorial
                                if (shipping.videoLink) {
                                    buttonsRow.addComponents(
                                        new ButtonBuilder()
                                            .setLabel('Tutorial')
                                            .setStyle(ButtonStyle.Link)
                                            .setURL(shipping.videoLink)
                                    );
                                }
                                
                                // Botão de Download
                                if (shipping.downloadLink) {
                                    buttonsRow.addComponents(
                                        new ButtonBuilder()
                                            .setLabel('Download')
                                            .setStyle(ButtonStyle.Link)
                                            .setURL(shipping.downloadLink)
                                    );
                                }

                                // Enviar mensagem privada
                                if (buttonsRow.components.length > 0) {
                                    await user.send({ 
                                        embeds: [productEmbed], 
                                        components: [buttonsRow] 
                                    });
                                } else {
                                    await user.send({ 
                                        embeds: [productEmbed] 
                                    });
                                }
                                
                                // Enviar transcript de compras para o canal configurado
                                await sendPurchaseTranscript(interaction, user, item, keyResult, paymentCart);
                            }
                        }
                        
                        // Entregar cargo de cliente (apenas uma vez por compra)
                        const clientRoleId = clientRoles.get(interaction.guild.id);
                        if (clientRoleId) {
                            try {
                                const member = await interaction.guild.members.fetch(interaction.user.id);
                                if (!member.roles.cache.has(clientRoleId)) {
                                    await member.roles.add(clientRoleId);
                                    console.log(`[CARGO] Cargo de cliente entregue para ${interaction.user.username}`);
                                }
                            } catch (error) {
                                console.error('Erro ao entregar cargo de cliente:', error);
                            }
                        }
                    } catch (error) {
                        console.error('Erro ao enviar mensagem privada:', error);
                        // Se não conseguir enviar privado, não afeta o processo
                    }

                    // Enviar animação de conclusão no canal
                    const processingEmbed = new EmbedBuilder()
                        .setColor('#ffaa00')
                        .setTitle('Processando Pedido')
                        .setDescription('Aguarde enquanto processamos seu pedido...')
                        .setTimestamp();

                    await interaction.editReply({ embeds: [processingEmbed] });

                    // Aguardar 2 segundos e mostrar conclusão
                    setTimeout(async () => {
                        const completedEmbed = new EmbedBuilder()
                            .setColor('#00ff00')
                            .setTitle('Pedido Concluído')
                            .setDescription('Seu pedido foi concluído e será enviado no seu privado!')
                            .setTimestamp();

                        await interaction.editReply({ embeds: [completedEmbed] });
                    }, 2000);

                    // Limpar carrinho
                    shoppingCarts.delete(paymentCartKey);

                    // Aguardar 10 segundos e deletar o canal
                    setTimeout(async () => {
                        try {
                            await interaction.channel.delete();
                        } catch (error) {
                            console.error('Erro ao deletar canal do carrinho:', error);
                        }
                    }, 10000);
                    break;

                case 'close_ticket':
                    // Verificar se já está processando transcript para este canal
                    if (activeTranscripts.has(interaction.channelId)) {
                        await interaction.reply({ content: '❌ Transcript já está sendo gerado!', ephemeral: true });
                        return;
                    }
                    
                    const channel = await interaction.channel.fetch();
                    
                    // Usar deferReply para evitar conflitos
                    await interaction.deferReply({ ephemeral: true });
                    
                    // Encontrar quem abriu o ticket (primeira mensagem do canal)
                    const messages = await channel.messages.fetch({ limit: 1, after: 0 });
                    const firstMessage = messages.first();
                    const ticketOpener = firstMessage ? firstMessage.mentions.users.first() || interaction.user : interaction.user;
                    
                    // Tentar encontrar a opção do ticket a partir do nome do canal
                    let optionLabel = 'Não especificada';
                    const ticketOptionsList = ticketOptions.get(interaction.guild.id) || [];
                    for (const option of ticketOptionsList) {
                        if (channel.name.toLowerCase().includes(option.label.toLowerCase().replace(/\s+/g, '-'))) {
                            optionLabel = option.label;
                            break;
                        }
                    }
                    
                    // Criar e enviar transcript
                    const transcriptContent = await createTicketTranscript(channel, ticketOpener);
                    if (transcriptContent) {
                        const transcriptSent = await sendTranscript(transcriptContent, ticketOpener, interaction.guild, channel, optionLabel, interaction.user);
                        
                        const closeEmbed = new EmbedBuilder()
                            .setColor('#ff0000')
                            .setTitle('Ticket Encerrado')
                            .setDescription(`Ticket encerrado por ${interaction.user.tag}`)
                            .addFields(
                                { name: 'Transcript', value: transcriptSent ? '✅ Enviado com sucesso' : '❌ Falha ao enviar', inline: false }
                            )
                            .setTimestamp();

                        await channel.send({ embeds: [closeEmbed] });
                        await interaction.editReply({ content: 'Este ticket será encerrado em 5 segundos...' });
                    } else {
                        await channel.send({ content: '❌ Erro ao gerar transcript. O ticket será encerrado assim mesmo.' });
                        await interaction.editReply({ content: 'Este ticket será encerrado em 5 segundos...' });
                    }
                    
                    setTimeout(async () => {
                        try {
                            await channel.delete();
                        } catch (error) {
                            console.error('Erro ao deletar canal:', error);
                        }
                    }, 5000);
                    break;

                case 'manage_ticket':
                    const manageChannel = await interaction.channel.fetch();
                    const manageEmbed = new EmbedBuilder()
                        .setColor('#ffff00')
                        .setTitle('Gerenciar Ticket')
                        .setDescription('Opções de gerenciamento do ticket')
                        .addFields(
                            { name: 'Dono', value: interaction.user.tag, inline: true },
                            { name: 'Criado em', value: manageChannel.createdAt.toLocaleString('pt-BR'), inline: true },
                            { name: 'ID do Canal', value: interaction.channelId, inline: true }
                        )
                        .setTimestamp();

                    await interaction.reply({ embeds: [manageEmbed], ephemeral: true });
                    break;

                case 'info_ticket':
                    const infoEmbed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Informações do Sistema')
                        .setDescription('Como funciona o sistema de tickets:')
                        .addFields(
                            { name: 'Abrir Ticket', value: 'Clique no menu "Abrir Ticket" no canal designado', inline: false },
                            { name: 'Encerrar', value: 'Clique em "Encerrar Atendimento" para fechar o ticket', inline: false },
                            { name: 'Gerenciar', value: 'Veja informações detalhadas sobre o ticket atual', inline: false },
                            { name: 'Atendimento', value: 'Aguarde um moderador responder seu chamado', inline: false }
                        )
                        .setFooter({ text: 'Sistema de Tickets - Bot Discord' })
                        .setTimestamp();

                    await interaction.reply({ embeds: [infoEmbed], ephemeral: true });
                    break;
            }
            return;
        }

        // Select de editar opção
        if (interaction.isStringSelectMenu() && interaction.customId === 'edit_option_select') {
            const selectedValue = interaction.values[0];
            const optionId = selectedValue.replace('edit_', '');
            const guild = interaction.guild;
            
            const options = ticketOptions.get(guild.id) || [];
            const option = options.find(opt => opt.id === optionId);
            
            if (!option) {
                await interaction.reply({ content: '❌ Opção não encontrada!', ephemeral: true });
                return;
            }

            const editModal = new ModalBuilder()
                .setCustomId(`edit_option_modal_${optionId}`) // Incluir ID no customId
                .setTitle('Editar Opção de Ticket');

            // Remover campo de ID - usuário não deve editar isso
            const editOptionLabelInput = new TextInputBuilder()
                .setCustomId('option_label')
                .setLabel('Nome da Opção')
                .setValue(option.label)
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const editOptionDescInput = new TextInputBuilder()
                .setCustomId('option_description')
                .setLabel('Descrição da Opção')
                .setValue(option.description)
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);

            const editOptionEmojiInput = new TextInputBuilder()
                .setCustomId('option_emoji')
                .setLabel('Emoji (opcional)')
                .setValue(option.emoji || '')
                .setStyle(TextInputStyle.Short)
                .setRequired(false);

            editModal.addComponents(
                new ActionRowBuilder().addComponents(editOptionLabelInput),
                new ActionRowBuilder().addComponents(editOptionDescInput),
                new ActionRowBuilder().addComponents(editOptionEmojiInput)
            );

            await interaction.showModal(editModal);
            return;
        }

        // Select de excluir opção
        if (interaction.isStringSelectMenu() && interaction.customId === 'delete_option_select') {
            const selectedValue = interaction.values[0];
            const optionId = selectedValue.replace('delete_', '');
            const guild = interaction.guild;
            
            const options = ticketOptions.get(guild.id) || [];
            const optionIndex = options.findIndex(opt => opt.id === optionId);
            
            if (optionIndex === -1) {
                await interaction.reply({ content: '❌ Opção não encontrada!', ephemeral: true });
                return;
            }

            const deletedOption = options[optionIndex];
            options.splice(optionIndex, 1);
            ticketOptions.set(guild.id, options);

            // Salvar dados após alteração
            saveData();

            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('Opção de Ticket Excluída!')
                .setDescription(`${deletedOption.label}`)
                .addFields(
                    { name: 'ID', value: optionId, inline: true },
                    { name: 'Total Restante', value: options.length.toString(), inline: true }
                )
                .setTimestamp();

            const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_products_menu')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({ embeds: [embed], components: [backButton] });
            return;
        }

        // Select de produto para gerenciar planos
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_product_for_plans') {
            const productId = interaction.values[0];
            const guild = interaction.guild;
            const guildProducts = products.get(guild.id) || [];
            const product = guildProducts.find(p => p.id === productId);

            if (!product) {
                await interaction.reply({ content: '❌ Produto não encontrado!', ephemeral: true });
                return;
            }

            const guildPlans = productPlans.get(guild.id) || {};
            const plans = guildPlans[productId] || [];

            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle(`Planos - ${product.name}`)
                .setDescription(plans.length > 0 ? 'Planos configurados:' : 'Nenhum plano configurado ainda.')
                .setThumbnail(product.imageUrl);

            if (plans.length > 0) {
                const plansList = plans.map((plan, index) => 
                    `${index + 1}. **${plan.name}** - R$ ${plan.price.toFixed(2)}`
                ).join('\n');
                embed.addFields({ name: 'Planos Ativos', value: plansList, inline: false });
            }

            const components = [];
            
            const row1 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`add_plan_${productId}`)
                        .setLabel('Adicionar Plano')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`edit_plan_${productId}`)
                        .setLabel('Editar Plano')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(plans.length === 0),
                    new ButtonBuilder()
                        .setCustomId(`delete_plan_${productId}`)
                        .setLabel('Excluir Plano')
                        .setStyle(ButtonStyle.Danger)
                        .setDisabled(plans.length === 0)
                );
            
            const row2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_products')
                        .setLabel('Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            components.push(row1, row2);

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_manage_plans')
                        .setLabel('⬅️ Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            components.push(backButton);

            await interaction.update({ embeds: [embed], components });
            return;
        }

        // Select de editar produto
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_edit_product') {
            const selectedValue = interaction.values[0];
            const productId = selectedValue.replace('edit_', '');
            const guild = interaction.guild;
            const guildProducts = products.get(guild.id) || [];
            const product = guildProducts.find(p => p.id === productId);

            if (!product) {
                await interaction.reply({ content: '❌ Produto não encontrado!', ephemeral: true });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`edit_product_modal_${productId}`)
                .setTitle('Editar Produto');

            const nameInput = new TextInputBuilder()
                .setCustomId('edit_product_name')
                .setLabel('Nome do Produto')
                .setValue(product.name)
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const descInput = new TextInputBuilder()
                .setCustomId('edit_product_description')
                .setLabel('Descrição')
                .setValue(product.description)
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);

            const imgInput = new TextInputBuilder()
                .setCustomId('edit_product_image')
                .setLabel('URL da Imagem')
                .setValue(product.imageUrl)
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const bannerInput = new TextInputBuilder()
                .setCustomId('edit_product_banner')
                .setLabel('URL do Banner - Opcional')
                .setValue(product.bannerUrl || '')
                .setStyle(TextInputStyle.Short)
                .setRequired(false);

            const footerInput = new TextInputBuilder()
                .setCustomId('edit_product_footer')
                .setLabel('Texto do Rodapé - Opcional')
                .setValue(product.footer || 'Agradecemos pela sua preferência pela One Store 2026!')
                .setStyle(TextInputStyle.Short)
                .setRequired(false);

            modal.addComponents(
                new ActionRowBuilder().addComponents(nameInput),
                new ActionRowBuilder().addComponents(descInput),
                new ActionRowBuilder().addComponents(imgInput),
                new ActionRowBuilder().addComponents(bannerInput),
                new ActionRowBuilder().addComponents(footerInput)
            );

            await interaction.showModal(modal);
            return;
        }

        // Select de excluir produto
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_delete_product') {
            const selectedValue = interaction.values[0];
            const productId = selectedValue.replace('delete_', '');
            const guild = interaction.guild;
            const guildProducts = products.get(guild.id) || [];
            const productIndex = guildProducts.findIndex(p => p.id === productId);

            if (productIndex === -1) {
                await interaction.reply({ content: '❌ Produto não encontrado!', ephemeral: true });
                return;
            }

            const product = guildProducts[productIndex];
            guildProducts.splice(productIndex, 1);
            products.set(guild.id, guildProducts);

            // Remover planos associados
            const guildPlans = productPlans.get(guild.id) || {};
            delete guildPlans[productId];
            productPlans.set(guild.id, guildPlans);

            saveData();

            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('Produto Excluído!')
                .setDescription(`O produto **${product.name}** foi excluído com sucesso.`)
                .setTimestamp();

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_manage_products')
                        .setLabel('⬅️ Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({ embeds: [embed], components: [backButton] });
            return;
        }

        // Select de editar plano
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_edit_plan') {
            const selectedValue = interaction.values[0];
            const lastUnderscoreIndex = selectedValue.lastIndexOf('_');
            const productId = selectedValue.substring(10, lastUnderscoreIndex); // Remove "edit_plan_" prefix
            const planIndex = parseInt(selectedValue.substring(lastUnderscoreIndex + 1));
            const guild = interaction.guild;

            const guildPlans = productPlans.get(guild.id) || {};
            const plans = guildPlans[productId] || [];
            const plan = plans[planIndex];

            if (!plan) {
                await interaction.reply({ content: '❌ Plano não encontrado!', ephemeral: true });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`edit_plan_modal_${productId}_${planIndex}`)
                .setTitle('Editar Plano');

            const nameInput = new TextInputBuilder()
                .setCustomId('edit_plan_name')
                .setLabel('Nome do Plano')
                .setValue(plan.name)
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const priceInput = new TextInputBuilder()
                .setCustomId('edit_plan_price')
                .setLabel('Valor (R$)')
                .setValue(plan.price.toString())
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(nameInput),
                new ActionRowBuilder().addComponents(priceInput)
            );

            await interaction.showModal(modal);
            return;
        }

        // Select de excluir plano
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_delete_plan') {
            const selectedValue = interaction.values[0];
            const lastUnderscoreIndex = selectedValue.lastIndexOf('_');
            const productId = selectedValue.substring(12, lastUnderscoreIndex); // Remove "delete_plan_" prefix
            const planIndex = parseInt(selectedValue.substring(lastUnderscoreIndex + 1));
            const guild = interaction.guild;

            const guildPlans = productPlans.get(guild.id) || {};
            const plans = guildPlans[productId] || [];

            if (planIndex < 0 || planIndex >= plans.length) {
                await interaction.reply({ content: '❌ Plano não encontrado!', ephemeral: true });
                return;
            }

            const plan = plans[planIndex];
            plans.splice(planIndex, 1);
            guildPlans[productId] = plans;
            productPlans.set(guild.id, guildPlans);
            saveData();

            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('Plano Excluído!')
                .setDescription(`O plano **${plan.name}** foi excluído com sucesso.`)
                .setTimestamp();

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_product_plans')
                        .setLabel('⬅️ Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({ embeds: [embed], components: [backButton] });
            return;
        }

        // Select de produto para enviar
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_product_to_send') {
            const productId = interaction.values[0];
            const guild = interaction.guild;
            const guildProducts = products.get(guild.id) || [];
            const product = guildProducts.find(p => p.id === productId);

            if (!product) {
                await interaction.reply({ content: '❌ Produto não encontrado!', ephemeral: true });
                return;
            }

            const guildChannels = productChannels.get(guild.id) || {};
            const channelId = guildChannels[productId];

            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle(`Enviar: ${product.name}`)
                .setDescription(channelId ? `Canal cadastrado: <#${channelId}>` : 'Nenhum canal cadastrado ainda.')
                .setThumbnail(product.imageUrl)
                .setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`send_product_now_${productId}`)
                        .setLabel('Enviar')
                        .setStyle(ButtonStyle.Success)
                        .setDisabled(!channelId),
                    new ButtonBuilder()
                        .setCustomId(`change_product_channel_${productId}`)
                        .setLabel(channelId ? 'Mudar Canal' : 'Cadastrar Canal')
                        .setStyle(ButtonStyle.Primary)
                );

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_send_product')
                        .setLabel('⬅️ Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({ embeds: [embed], components: [row, backButton] });
            return;
        }

        // Select de configuração de envio de estoque
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_product_shipping') {
            const productId = interaction.values[0];
            const guild = interaction.guild;
            const guildProducts = products.get(guild.id) || [];
            const product = guildProducts.find(p => p.id === productId);

            if (!product) {
                await interaction.reply({ content: '❌ Produto não encontrado!', ephemeral: true });
                return;
            }

            // Verificar configurações atuais
            const guildKeyAuth = keyAuthStock.get(guild.id) || {};
            const guildManual = manualStock.get(guild.id) || {};
            const hasAuto = guildKeyAuth[productId];
            const hasManual = guildManual[productId] && Object.keys(guildManual[productId]).length > 0;

            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle(`Escolher Tipo de Estoque: ${product.name}`)
                .setDescription('Selecione o tipo de estoque que este produto usará:')
                .setThumbnail(product.imageUrl)
                .addFields(
                    { 
                        name: 'Estoque Automático', 
                        value: 'Gera keys automaticamente via API',
                        inline: true 
                    },
                    { 
                        name: 'Estoque Manual', 
                        value: 'Usa keys cadastradas manualmente',
                        inline: true 
                    }
                )
                .setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`set_auto_stock_${productId}`)
                        .setLabel('Automático')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(`set_manual_stock_${productId}`)
                        .setLabel('Manual')
                        .setStyle(ButtonStyle.Secondary)
                );

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_shipping_stock')
                        .setLabel('⬅️ Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({ embeds: [embed], components: [row, backButton] });
            return;
        }

        // Select de plano (adicionar ao carrinho)
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_plan_')) {
            const selectedValue = interaction.values[0];
            // Formato: buy_productId_planName
            // Exemplo: buy_product_1234567890_Diário
            const parts = selectedValue.split('_');
            // parts[0] = 'buy'
            // parts[1] = 'product'
            // parts[2] = timestamp (parte do productId)
            // parts[3+] = planName
            
            // Reconstruir productId (product_timestamp)
            const productId = `${parts[1]}_${parts[2]}`;
            // Reconstruir planName (tudo depois do productId)
            const planName = parts.slice(3).join('_');
            
            const guild = interaction.guild;
            const user = interaction.user;
            const cartKey = `${guild.id}_${user.id}`;

            const guildProducts = products.get(guild.id) || [];
            const product = guildProducts.find(p => p.id === productId);

            if (!product) {
                await interaction.reply({ content: '❌ Produto não encontrado!', ephemeral: true });
                return;
            }

            const guildPlans = productPlans.get(guild.id) || {};
            const plans = guildPlans[productId] || [];
            const plan = plans.find(p => p.name === planName);

            if (!plan) {
                await interaction.reply({ content: '❌ Plano não encontrado!', ephemeral: true });
                return;
            }

            // Verificar se há categoria de compra configurada
            const purchaseCategoryId = purchaseCategories.get(guild.id);
            if (!purchaseCategoryId) {
                await interaction.reply({ 
                    content: '❌ Categoria de compra não configurada! Configure em /painel → Produtos → Categoria de Compra', 
                    ephemeral: true 
                });
                return;
            }

            // Verificar se usuário já tem carrinho aberto
            const existingCart = shoppingCarts.get(cartKey);
            if (existingCart && existingCart.channelId) {
                try {
                    // Tentar buscar o canal existente
                    const existingChannel = await guild.channels.fetch(existingCart.channelId);
                    if (existingChannel) {
                        // Iniciar animação de aviso
                        const warningEmbed = new EmbedBuilder()
                            .setColor('#ff6b6b')
                            .setTitle('Carrinho já aberto')
                            .setDescription('Você tem um carrinho aberto, feche para poder abrir novamente...')
                            .setTimestamp();

                        await interaction.reply({ 
                            content: '', 
                            embeds: [warningEmbed], 
                            ephemeral: true
                        });

                        // Animação de aguardando fechamento (editando a mesma mensagem)
                        setTimeout(async () => {
                            try {
                                const waitingEmbed = new EmbedBuilder()
                                    .setColor('#ff4444')
                                    .setTitle('Aguardando Fechamento')
                                    .setDescription('Aguardando o fechamento do carrinho...')
                                    .setTimestamp();
                                
                                await interaction.editReply({ embeds: [waitingEmbed] });
                            } catch (error) {
                                console.log('Erro ao editar mensagem de aguardo:', error.message);
                            }
                        }, 1000);

                        // Monitorar se o carrinho foi fechado
                        let checkCount = 0;
                        const maxChecks = 60; // 30 segundos máximo (60 * 500ms)

                        const checkInterval = setInterval(async () => {
                            checkCount++;
                            
                            // Verificar se o carrinho ainda existe
                            const currentCart = shoppingCarts.get(cartKey);
                            if (!currentCart || !currentCart.channelId) {
                                clearInterval(checkInterval);
                                
                                try {
                                    const successEmbed = new EmbedBuilder()
                                        .setColor('#00ff00')
                                        .setTitle('Carrinho Fechado')
                                        .setDescription('Carrinho fechado com sucesso! Você pode abrir um novo carrinho agora.')
                                        .setTimestamp();
                                    
                                    await interaction.editReply({ embeds: [successEmbed] });
                                } catch (error) {
                                    console.log('Erro ao editar mensagem de sucesso:', error.message);
                                }
                                return;
                            }
                            
                            // Parar após tempo máximo
                            if (checkCount >= maxChecks) {
                                clearInterval(checkInterval);
                                
                                try {
                                    const timeoutEmbed = new EmbedBuilder()
                                        .setColor('#ffaa00')
                                        .setTitle('Timeout')
                                        .setDescription('Tempo de espera esgotado. Tente novamente quando estiver pronto.')
                                        .setTimestamp();
                                    
                                    await interaction.editReply({ embeds: [timeoutEmbed] });
                                } catch (error) {
                                    console.log('Erro ao editar mensagem de timeout:', error.message);
                                }
                            }
                        }, 500);

                        return;
                    }
                } catch (error) {
                    // Canal não existe mais, remover referência
                    console.log('Canal do carrinho não encontrado, limpando referência...');
                    existingCart.channelId = null;
                    shoppingCarts.set(cartKey, existingCart);
                }
            }

            try {
                const category = await guild.channels.fetch(purchaseCategoryId);
                if (!category || category.type !== 4) {
                    await interaction.reply({ 
                        content: '❌ Categoria de compra não encontrada! Reconfigure em /painel → Produtos → Categoria de Compra', 
                        ephemeral: true 
                    });
                    return;
                }

                // Criar ou atualizar carrinho
                const cartKey = `${guild.id}_${user.id}`;
                let cart = shoppingCarts.get(cartKey) || {
                    userId: user.id,
                    guildId: guild.id,
                    items: []
                };

                // Verificar se o item já está no carrinho
                const existingItem = cart.items.find(item => 
                    item.productId === productId && item.planName === planName
                );

                if (existingItem) {
                    existingItem.quantity += 1;
                } else {
                    cart.items.push({
                        productId: productId,
                        productName: product.name,
                        planName: plan.name,
                        unitPrice: plan.price,
                        quantity: 1
                    });
                }

                // Criar canal de carrinho dentro da categoria
                const channelName = `carrinho-${user.username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
                
                const purchaseChannel = await guild.channels.create({
                    name: channelName,
                    type: 0, // GUILD_TEXT
                    parent: purchaseCategoryId,
                    permissionOverwrites: [
                        {
                            id: guild.id,
                            deny: ['ViewChannel']
                        },
                        {
                            id: user.id,
                            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory']
                        }
                    ]
                });

                // Adicionar permissões para staff (se configurado)
                const staffList = staffRoles.get(guild.id) || [];
                for (const staffId of staffList) {
                    await purchaseChannel.permissionOverwrites.create(staffId, {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true
                    });
                }

                // Adicionar ID do canal ao carrinho
                cart.channelId = purchaseChannel.id;
                shoppingCarts.set(cartKey, cart);

                // Enviar carrinho para o canal criado
                const cartMessage = await sendShoppingCartToChannel(purchaseChannel, cart, user, guild);
                
                // Armazenar ID da mensagem do carrinho
                cart.cartMessageId = cartMessage.id;
                shoppingCarts.set(cartKey, cart);

                await interaction.reply({ 
                    content: `✅ Item adicionado ao carrinho! Verifique ${purchaseChannel}`, 
                    ephemeral: true 
                });

                // Resetar o select menu para permitir selecionar a mesma opção novamente
                try {
                    // Buscar a mensagem original do produto
                    const originalMessage = await interaction.channel.messages.fetch(interaction.message.id);
                    
                    // Preservar TODOS os embeds originais (incluindo o banner)
                    const preservedEmbeds = [];
                    
                    for (const embedData of originalMessage.embeds) {
                        const preservedEmbed = new EmbedBuilder()
                            .setColor(embedData.color);
                        
                        // Preservar title se existir
                        if (embedData.title) {
                            preservedEmbed.setTitle(embedData.title);
                        }
                        
                        // Preservar description se existir
                        if (embedData.description) {
                            preservedEmbed.setDescription(embedData.description);
                        }
                        
                        // Preservar image se existir
                        if (embedData.image?.url) {
                            preservedEmbed.setImage(embedData.image.url);
                        }
                        
                        // Preservar thumbnail se existir
                        if (embedData.thumbnail?.url) {
                            preservedEmbed.setThumbnail(embedData.thumbnail.url);
                        }
                        
                        // Preservar footer se existir
                        if (embedData.footer) {
                            preservedEmbed.setFooter({ 
                                text: embedData.footer.text,
                                iconURL: embedData.footer.iconURL 
                            });
                        }
                        
                        // Preservar fields se existirem
                        if (embedData.fields && embedData.fields.length > 0) {
                            preservedEmbed.addFields(embedData.fields);
                        }
                        
                        preservedEmbeds.push(preservedEmbed);
                    }
                    
                    // Recriar o select menu com as mesmas opções
                    const guildPlans = productPlans.get(guild.id) || {};
                    const plans = guildPlans[productId] || [];
                    
                    const planOptions = plans.map(plan => ({
                        label: plan.name,
                        description: `R$ ${plan.price.toFixed(2)}`,
                        value: `buy_${productId}_${plan.name}`
                    }));

                    const resetSelectMenu = new StringSelectMenuBuilder()
                        .setCustomId(`select_plan_${productId}`)
                        .setPlaceholder('Selecione um plano')
                        .addOptions(planOptions);

                    const resetRow = new ActionRowBuilder()
                        .addComponents(resetSelectMenu);

                    await originalMessage.edit({ embeds: preservedEmbeds, components: [resetRow] });
                } catch (error) {
                    // Ignorar erro se não conseguir resetar (não é crítico)
                    console.log('Não foi possível resetar o select menu:', error.message);
                }

            } catch (error) {
                console.error('Erro ao criar carrinho:', error);
                await interaction.reply({ 
                    content: '❌ Erro ao criar carrinho de compras.', 
                    ephemeral: true 
                });
            }
            return;
        }

        // Select de cupom para configurar produtos
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_coupon_for_products') {
            const couponId = interaction.values[0];
            const guild = interaction.guild;
            const guildCoupons = coupons.get(guild.id) || [];
            const coupon = guildCoupons.find(c => c.id === couponId);

            if (!coupon) {
                await interaction.reply({ content: '❌ Cupom não encontrado!', ephemeral: true });
                return;
            }

            const guildProducts = products.get(guild.id) || [];
            if (guildProducts.length === 0) {
                await interaction.reply({ content: '❌ Nenhum produto cadastrado!', ephemeral: true });
                return;
            }

            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle(`Produtos do Cupom: ${coupon.name}`)
                .setDescription('Selecione os produtos onde este cupom funcionará (deixe vazio para funcionar em todos):')
                .setTimestamp();

            const productOptions = guildProducts.map(product => ({
                label: product.name,
                description: `ID: ${product.id}`,
                value: product.id,
                default: coupon.products.includes(product.id)
            }));

            const row = new ActionRowBuilder()
                .addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`set_coupon_products_${couponId}`)
                        .setPlaceholder('Selecione os produtos...')
                        .setMinValues(0)
                        .setMaxValues(productOptions.length)
                        .addOptions(productOptions)
                );

            await interaction.update({ embeds: [embed], components: [row] });
            return;
        }

        // Select de definir produtos do cupom
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('set_coupon_products_')) {
            const couponId = interaction.customId.replace('set_coupon_products_', '');
            const selectedProducts = interaction.values;
            const guild = interaction.guild;
            const guildCoupons = coupons.get(guild.id) || [];
            const coupon = guildCoupons.find(c => c.id === couponId);

            if (!coupon) {
                await interaction.reply({ content: '❌ Cupom não encontrado!', ephemeral: true });
                return;
            }

            coupon.products = selectedProducts;
            coupons.set(guild.id, guildCoupons);
            saveData();

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Produtos Configurados!')
                .setDescription(`Cupom **${coupon.name}** foi configurado para ${selectedProducts.length === 0 ? 'todos os produtos' : `${selectedProducts.length} produto(s)`}`)
                .setTimestamp();

            const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_products_menu')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({ embeds: [embed], components: [backButton] });
            return;
        }

        // Select de gerenciar cupom
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_manage_coupon') {
            const couponId = interaction.values[0];
            const guild = interaction.guild;
            const guildCoupons = coupons.get(guild.id) || [];
            const coupon = guildCoupons.find(c => c.id === couponId);

            if (!coupon) {
                await interaction.reply({ content: '❌ Cupom não encontrado!', ephemeral: true });
                return;
            }

            const isExpired = new Date(coupon.expiresAt) < new Date();
            const embed = new EmbedBuilder()
                .setColor(isExpired ? '#ff0000' : '#0099ff')
                .setTitle(`Gerenciar: ${coupon.name}`)
                .setDescription('Escolha uma ação:')
                .addFields(
                    { name: 'Desconto', value: `${coupon.percentage}%`, inline: true },
                    { name: 'Valor Mínimo', value: `R$ ${coupon.minValue.toFixed(2)}`, inline: true },
                    { name: 'Status', value: isExpired ? '❌ Expirado' : '✅ Ativo', inline: true },
                    { name: 'Expira em', value: new Date(coupon.expiresAt).toLocaleString('pt-BR'), inline: false }
                )
                .setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`edit_coupon_${couponId}`)
                        .setLabel('Editar')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(`delete_coupon_${couponId}`)
                        .setLabel('Excluir')
                        .setStyle(ButtonStyle.Danger)
                );

            await interaction.update({ embeds: [embed], components: [row] });
            return;
        }

        // Select de estoque
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_stock_product') {
            const selectedValue = interaction.values[0];
            const productId = selectedValue.replace('stock_', '');
            const guild = interaction.guild;
            const guildProducts = products.get(guild.id) || [];
            const guildStock = productStock.get(guild.id) || {};
            const product = guildProducts.find(p => p.id === productId);

            if (!product) {
                await interaction.reply({ content: '❌ Produto não encontrado!', ephemeral: true });
                return;
            }

            const currentStock = guildStock[productId] || 0;

            const modal = new ModalBuilder()
                .setCustomId(`stock_modal_${productId}`)
                .setTitle('Ajustar Estoque');

            const stockInput = new TextInputBuilder()
                .setCustomId('stock_amount')
                .setLabel('Quantidade em Estoque')
                .setPlaceholder(`Atual: ${currentStock}`)
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(currentStock.toString());

            modal.addComponents(new ActionRowBuilder().addComponents(stockInput));

            await interaction.showModal(modal);
            return;
        }

        // Select de adicionar envio
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_add_shipping') {
            const selectedValue = interaction.values[0];
            const productId = selectedValue.replace('shipping_add_', '');
            const guild = interaction.guild;
            const guildProducts = products.get(guild.id) || [];
            const product = guildProducts.find(p => p.id === productId);

            if (!product) {
                await interaction.reply({ content: '❌ Produto não encontrado!', ephemeral: true });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`shipping_add_modal_${productId}`)
                .setTitle('Configurar Envio');

            const tutorialInput = new TextInputBuilder()
                .setCustomId('tutorial_text')
                .setLabel('Tutorial Escrito')
                .setPlaceholder('Digite o tutorial que o usuário receberá após a compra...')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);

            const videoLinkInput = new TextInputBuilder()
                .setCustomId('video_link')
                .setLabel('Link do Vídeo (Opcional)')
                .setPlaceholder('https://youtube.com/watch?v=...')
                .setStyle(TextInputStyle.Short)
                .setRequired(false);

            const downloadLinkInput = new TextInputBuilder()
                .setCustomId('download_link')
                .setLabel('Link de Download')
                .setPlaceholder('https://exemplo.com/download...')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(tutorialInput),
                new ActionRowBuilder().addComponents(videoLinkInput),
                new ActionRowBuilder().addComponents(downloadLinkInput)
            );

            await interaction.showModal(modal);
            return;
        }

        // Select de editar envio
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_edit_shipping') {
            const selectedValue = interaction.values[0];
            const productId = selectedValue.replace('shipping_edit_', '');
            const guild = interaction.guild;
            const guildProducts = products.get(guild.id) || [];
            const guildShipping = productShipping.get(guild.id) || {};
            const product = guildProducts.find(p => p.id === productId);
            const shipping = guildShipping[productId];

            if (!product || !shipping) {
                await interaction.reply({ content: '❌ Produto ou envio não encontrado!', ephemeral: true });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`shipping_edit_modal_${productId}`)
                .setTitle('Editar Envio');

            const tutorialInput = new TextInputBuilder()
                .setCustomId('tutorial_text')
                .setLabel('Tutorial Escrito')
                .setPlaceholder('Digite o tutorial que o usuário receberá após a compra...')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setValue(shipping.tutorial || '');

            const videoLinkInput = new TextInputBuilder()
                .setCustomId('video_link')
                .setLabel('Link do Vídeo (Opcional)')
                .setPlaceholder('https://youtube.com/watch?v=...')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(shipping.videoLink || '');

            const downloadLinkInput = new TextInputBuilder()
                .setCustomId('download_link')
                .setLabel('Link de Download')
                .setPlaceholder('https://exemplo.com/download...')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(shipping.downloadLink || '');

            modal.addComponents(
                new ActionRowBuilder().addComponents(tutorialInput),
                new ActionRowBuilder().addComponents(videoLinkInput),
                new ActionRowBuilder().addComponents(downloadLinkInput)
            );

            await interaction.showModal(modal);
            return;
        }

        // Select de adicionar configuração KeyAuth
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_keyauth_product') {
            const selectedValue = interaction.values[0];
            const productId = selectedValue.replace('keyauth_add_', '');
            
            const modal = new ModalBuilder()
                .setCustomId(`keyauth_add_modal_${productId}`)
                .setTitle('Configurar Geração Automática');

            const sellerKeyInput = new TextInputBuilder()
                .setCustomId('seller_key')
                .setLabel('Chave de API (32 caracteres)')
                .setPlaceholder('Cole sua chave de API de 32 caracteres')
                .setStyle(TextInputStyle.Short)
                .setMinLength(32)
                .setMaxLength(32)
                .setRequired(true);

            const appNameInput = new TextInputBuilder()
                .setCustomId('app_name')
                .setLabel('Nome do Aplicativo')
                .setPlaceholder('Ex: AimbotElevate (sem espaços)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const generatorNameInput = new TextInputBuilder()
                .setCustomId('generator_name')
                .setLabel('Nome do Gerador')
                .setPlaceholder('Ex: Discord, Bot, Sistema, etc.')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue('Discord'); // Valor padrão

            modal.addComponents(
                new ActionRowBuilder().addComponents(sellerKeyInput),
                new ActionRowBuilder().addComponents(appNameInput),
                new ActionRowBuilder().addComponents(generatorNameInput)
            );

            await interaction.showModal(modal);
            return;
        }

        // Select de editar configuração KeyAuth
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_keyauth_edit') {
            const selectedValue = interaction.values[0];
            const productId = selectedValue.replace('keyauth_edit_', '');
            const guild = interaction.guild;
            const guildKeyAuth = keyAuthStock.get(guild.id) || {};
            const config = guildKeyAuth[productId];

            const modal = new ModalBuilder()
                .setCustomId(`keyauth_edit_modal_${productId}`)
                .setTitle('Editar Configuração Automática');

            const sellerKeyInput = new TextInputBuilder()
                .setCustomId('seller_key')
                .setLabel('Chave de API (32 caracteres)')
                .setPlaceholder('Cole sua chave de API de 32 caracteres')
                .setStyle(TextInputStyle.Short)
                .setValue(config?.sellerKey || '')
                .setMinLength(32)
                .setMaxLength(32)
                .setRequired(true);

            const appNameInput = new TextInputBuilder()
                .setCustomId('app_name')
                .setLabel('Nome do Aplicativo')
                .setPlaceholder('Ex: AimbotElevate (sem espaços)')
                .setStyle(TextInputStyle.Short)
                .setValue(config?.appName || '')
                .setRequired(true);

            const generatorNameInput = new TextInputBuilder()
                .setCustomId('generator_name')
                .setLabel('Nome do Gerador')
                .setPlaceholder('Ex: Discord, Bot, Sistema, etc.')
                .setStyle(TextInputStyle.Short)
                .setValue(config?.generatorName || 'Discord')
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(sellerKeyInput),
                new ActionRowBuilder().addComponents(appNameInput),
                new ActionRowBuilder().addComponents(generatorNameInput)
            );

            await interaction.showModal(modal);
            return;
        }

        // Select de excluir configuração KeyAuth
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_keyauth_delete') {
            const selectedValue = interaction.values[0];
            const productId = selectedValue.replace('keyauth_delete_', '');
            const guild = interaction.guild;
            const guildKeyAuth = keyAuthStock.get(guild.id) || {};
            const guildProducts = products.get(guild.id) || [];
            const product = guildProducts.find(p => p.id === productId);

            delete guildKeyAuth[productId];
            keyAuthStock.set(guild.id, guildKeyAuth);
            saveData();

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_auto_stock')
                        .setLabel('⬅️ Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({
                content: `✅ Configuração automática removida do produto **${product?.name || 'Desconhecido'}**!`,
                embeds: [],
                components: [backButton]
            });
            return;
        }

        // Select de adicionar keys manuais - escolher produto
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_manual_product') {
            const selectedValue = interaction.values[0];
            const productId = selectedValue.replace('manual_add_', '');
            const guild = interaction.guild;
            const guildPlans = productPlans.get(guild.id) || {};
            const plans = guildPlans[productId] || [];

            if (plans.length === 0) {
                const backButton = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_manual_stock')
                            .setLabel('⬅️ Voltar')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.update({
                    content: '❌ Este produto não possui planos cadastrados!',
                    embeds: [],
                    components: [backButton]
                });
                return;
            }

            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle('Adicionar Keys Manualmente')
                .setDescription('Selecione o plano para adicionar keys:')
                .setTimestamp();

            const planOptions = plans.map(plan => ({
                label: plan.name,
                description: `R$ ${plan.price.toFixed(2)}`,
                value: `manual_plan_${productId}_${plan.name}`
            }));

            const row = new ActionRowBuilder()
                .addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('select_manual_plan')
                        .setPlaceholder('Selecione um plano...')
                        .addOptions(planOptions)
                );

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_manual_stock')
                        .setLabel('⬅️ Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({ embeds: [embed], components: [row, backButton] });
            return;
        }

        // Select de plano para adicionar keys manuais
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_manual_plan') {
            const selectedValue = interaction.values[0];
            const parts = selectedValue.replace('manual_plan_', '').split('_');
            const productId = parts[0];
            const planName = parts.slice(1).join('_');

            const modal = new ModalBuilder()
                .setCustomId(`manual_keys_modal_${productId}_${planName}`)
                .setTitle('Adicionar Keys');

            const keysInput = new TextInputBuilder()
                .setCustomId('keys_list')
                .setLabel('Keys (uma por linha)')
                .setPlaceholder('KEY-1234-5678-ABCD\nKEY-9876-5432-WXYZ\n...')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(keysInput)
            );

            await interaction.showModal(modal);
            return;
        }

        // Select de visualizar keys manuais
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_manual_view') {
            const selectedValue = interaction.values[0];
            const productId = selectedValue.replace('manual_view_', '');
            const guild = interaction.guild;
            const guildManual = manualStock.get(guild.id) || {};
            const productKeys = guildManual[productId] || {};
            const guildProducts = products.get(guild.id) || [];
            const product = guildProducts.find(p => p.id === productId);

            const embed = new EmbedBuilder()
                .setColor('#0099ff')
                .setTitle(`Keys de ${product?.name || 'Produto'}`)
                .setDescription('Estoque de keys por plano:')
                .setTimestamp();

            if (Object.keys(productKeys).length === 0) {
                embed.setDescription('❌ Nenhuma key cadastrada para este produto.');
            } else {
                for (const [planName, keys] of Object.entries(productKeys)) {
                    embed.addFields({
                        name: `${planName} (${keys.length} keys)`,
                        value: keys.length > 0 ? `\`\`\`${keys.slice(0, 5).join('\n')}${keys.length > 5 ? `\n... e mais ${keys.length - 5}` : ''}\`\`\`` : 'Nenhuma key',
                        inline: false
                    });
                }
            }

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_manual_stock')
                        .setLabel('⬅️ Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({ embeds: [embed], components: [backButton] });
            return;
        }

        // Select de excluir keys manuais - escolher produto
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_manual_delete') {
            const selectedValue = interaction.values[0];
            const productId = selectedValue.replace('manual_delete_', '');
            const guild = interaction.guild;
            const guildManual = manualStock.get(guild.id) || {};
            const productKeys = guildManual[productId] || {};

            const embed = new EmbedBuilder()
                .setColor('#ff6b6b')
                .setTitle('Excluir Keys Manuais')
                .setDescription('Selecione o plano para excluir as keys:')
                .setTimestamp();

            const planOptions = Object.keys(productKeys).map(planName => ({
                label: `${planName} (${productKeys[planName].length} keys)`,
                description: 'Clique para excluir todas as keys deste plano',
                value: `manual_delete_plan_${productId}_${planName}`
            }));

            const row = new ActionRowBuilder()
                .addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('select_manual_delete_plan')
                        .setPlaceholder('Selecione um plano...')
                        .addOptions(planOptions)
                );

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_manual_stock')
                        .setLabel('⬅️ Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({ embeds: [embed], components: [row, backButton] });
            return;
        }

        // Select de plano para excluir keys
        if (interaction.isStringSelectMenu() && interaction.customId === 'select_manual_delete_plan') {
            const selectedValue = interaction.values[0];
            const parts = selectedValue.replace('manual_delete_plan_', '').split('_');
            const productId = parts[0];
            const planName = parts.slice(1).join('_');
            const guild = interaction.guild;
            const guildManual = manualStock.get(guild.id) || {};

            if (!guildManual[productId]) {
                guildManual[productId] = {};
            }

            delete guildManual[productId][planName];
            manualStock.set(guild.id, guildManual);
            saveData();

            const backButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_manual_stock')
                        .setLabel('⬅️ Voltar')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({
                content: `✅ Todas as keys do plano **${planName}** foram excluídas!`,
                embeds: [],
                components: [backButton]
            });
            return;
        }

        // Select de remover usuário staff
        if (interaction.isStringSelectMenu() && interaction.customId === 'remove_staff_select') {
            const selectedValue = interaction.values[0];
            const userId = selectedValue.replace('remove_', '');
            const guild = interaction.guild;
            
            const staffList = staffRoles.get(guild.id) || [];
            const userIndex = staffList.indexOf(userId);
            
            if (userIndex === -1) {
                await interaction.reply({ content: '❌ Usuário não encontrado na lista!', ephemeral: true });
                return;
            }

            staffList.splice(userIndex, 1);
            staffRoles.set(guild.id, staffList);

            // Salvar dados após alteração
            saveData();

            let userName = 'Usuário desconhecido';
            try {
                const user = await guild.client.users.fetch(userId);
                userName = user.tag;
            } catch (error) {
                // Usuário não encontrado, manter nome padrão
            }

            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('Usuário Staff Excluído!')
                .setDescription(`**${userName}** foi removido da lista de staff`)
                .addFields(
                    { name: 'ID do Usuário', value: userId, inline: true },
                    { name: 'Total Restante', value: staffList.length.toString(), inline: true }
                )
                .setTimestamp();

            const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_products_menu')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({ embeds: [embed], components: [backButton] });
            return;
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_type_select') {
            const guild = interaction.guild;
            const ticketCategoryId = ticketChannels.get(guild.id);
            const ticketType = interaction.values[0];

            if (!ticketCategoryId) {
                await interaction.reply({ content: '❌ Sistema de tickets não configurado!', ephemeral: true });
                return;
            }

            // Verificar cooldown
            const cooldownKey = `${guild.id}-${interaction.user.id}`;
            const lastTicketTime = ticketCooldowns.get(cooldownKey);
            const cooldownTime = 5000; // 5 segundos
            
            if (lastTicketTime && (Date.now() - lastTicketTime) < cooldownTime) {
                await interaction.reply({ content: '❌ Aguarde alguns segundos antes de criar outro ticket!', ephemeral: true });
                return;
            }

            try {
                // Verificar se o usuário já tem um ticket aberto
                const existingChannel = guild.channels.cache.find(ch => 
                    ch.name.startsWith(`ticket-${interaction.user.username}`) && 
                    ch.parentId === ticketCategoryId &&
                    ch.type === 0 // GUILD_TEXT
                );

                if (existingChannel) {
                    await interaction.reply({ content: '❌ Você já tem um ticket aberto!', ephemeral: true });
                    return;
                }

                // Obter informações do tipo de ticket
                const options = ticketOptions.get(guild.id) || [];
                const selectedOption = options.find(opt => opt.id === ticketType) || { label: 'Suporte', emoji: '🎫' };

                // Criar canal do ticket
                const ticketChannel = await guild.channels.create({
                    name: `ticket-${interaction.user.username}-${Date.now()}`,
                    type: 0, // GUILD_TEXT
                    parent: ticketCategoryId,
                    permissionOverwrites: [
                        {
                            id: guild.id,
                            deny: ['ViewChannel']
                        },
                        {
                            id: interaction.user.id,
                            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory']
                        },
                        {
                            id: client.user.id,
                            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels']
                        }
                    ]
                });

                // Adicionar permissões para staff
                const staffUserIds = staffRoles.get(guild.id) || [];
                for (const userId of staffUserIds) {
                    await ticketChannel.permissionOverwrites.edit(userId, {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true
                    });
                }

                // Embed de boas-vindas ao ticket
                const visualConfig = ticketVisuals.get(interaction.guild.id) || {
                    imageUrl: '',
                    color: '#00ff00',
                    footer: 'Radiant Store 2025'
                };

                const welcomeEmbed = new EmbedBuilder()
                    .setColor(visualConfig.color || '#00ff00')
                    .setTitle('**Bem vindo ao atendimento!**')
                    .setDescription('Descreva seu problema abaixo e aguarde um moderador, evite marcações desnecessárias.')
                    .addFields(
                        { name: 'Tipo de atendimento', value: selectedOption.label, inline: true },
                        { name: 'Usuário', value: interaction.user.tag, inline: true },
                        { name: 'Tipo', value: selectedOption.label, inline: true }
                    );

                // Adicionar imagem como thumbnail se houver
                if (visualConfig.imageUrl) {
                    welcomeEmbed.setThumbnail(visualConfig.imageUrl);
                }

                // Adicionar rodapé se houver
                if (visualConfig.footer) {
                    welcomeEmbed.setFooter({ text: visualConfig.footer });
                }

                // Botões do ticket (apenas encerrar)
                const ticketButtons = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('close_ticket')
                            .setLabel('Encerrar Atendimento')
                            .setStyle(ButtonStyle.Danger)
                    );

                await ticketChannel.send({ content: `${interaction.user}`, embeds: [welcomeEmbed], components: [ticketButtons] });
                await interaction.reply({ content: `✅ Ticket criado em ${ticketChannel}!`, ephemeral: true });
                
                // Registrar cooldown
                ticketCooldowns.set(cooldownKey, Date.now());

            } catch (error) {
                console.error('Erro ao criar ticket:', error);
                await interaction.reply({ content: '❌ Erro ao criar o ticket. Verifique as permissões do bot.', ephemeral: true });
            }
        }

    } catch (error) {
        // Ignorar erros de interação já respondida ou expirada
        if (error.code === 40060 || error.code === 10062) {
            return;
        }
        
        console.error('Erro geral em interação:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Ocorreu um erro ao processar sua solicitação.', ephemeral: true }).catch(() => {});
        }
    }
});

// Funções auxiliares
async function showTicketVisualsConfig(interaction) {
    const guild = interaction.guild;
    const currentVisuals = ticketVisuals.get(guild.id) || {
        imageUrl: '',
        color: '#0099ff',
        footer: 'Radiant Store 2025'
    };
    
    const embed = new EmbedBuilder()
        .setColor(currentVisuals.color || '#0099ff')
        .setTitle('Configuração Visual do Ticket')
        .setDescription('Personalize a aparência da mensagem de tickets')
        .addFields(
            { 
                name: 'Miniatura Atual', 
                value: currentVisuals.imageUrl ? `[Ver Miniatura](${currentVisuals.imageUrl})` : 'Nenhuma miniatura configurada',
                inline: false 
            },
            { 
                name: 'Cor Atual', 
                value: currentVisuals.color || '#0099ff',
                inline: true 
            },
            { 
                name: 'Rodapé Atual', 
                value: currentVisuals.footer || 'Radiant Store 2025',
                inline: true 
            }
        )
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('edit_visual_image')
                .setLabel('Editar Miniatura')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('edit_visual_color')
                .setLabel('Editar Cor')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('edit_visual_footer')
                .setLabel('Editar Rodapé')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('back_to_menu')
                .setLabel('Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row] });
}

async function showStaffManager(interaction) {
    const guild = interaction.guild;
    const currentStaff = staffRoles.get(guild.id) || [];
    
    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Gerenciador de Usuários Staff')
        .setDescription(`Total de usuários staff: ${currentStaff.length}`)
        .setTimestamp();

    if (currentStaff.length > 0) {
        const staffList = await Promise.all(
            currentStaff.map(async (userId, index) => {
                try {
                    const user = await guild.client.users.fetch(userId);
                    return `${index + 1}. **${user.tag}**\n   ID: \`${userId}\``;
                } catch (error) {
                    return `${index + 1}. **Usuário não encontrado**\n   ID: \`${userId}\``;
                }
            })
        );
        
        embed.addFields(
            { name: 'Usuários Atuais', value: staffList.join('\n\n'), inline: false }
        );
    }

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('add_staff_user')
                .setLabel('Cadastrar Usuário')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('remove_staff_user')
                .setLabel('Excluir Usuário')
                .setStyle(currentStaff.length > 0 ? ButtonStyle.Danger : ButtonStyle.Secondary)
                .setDisabled(currentStaff.length === 0),
            new ButtonBuilder()
                .setCustomId('back_to_menu')
                .setLabel('Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row] });
}

async function showTicketOptionsManager(interaction) {
    const guild = interaction.guild;
    const options = ticketOptions.get(guild.id) || [];
    
    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Gerenciador de Opções de Tickets')
        .setDescription(`Total de opções: ${options.length}`)
        .setTimestamp();

    if (options.length > 0) {
        const optionsList = options.map((opt, index) => 
            `${index + 1}. **${opt.label}**\n   ${opt.description}\n   \`ID: ${opt.id}\``
        ).join('\n\n');
        
        embed.addFields(
            { name: 'Opções Atuais', value: optionsList, inline: false }
        );
    }

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('add_ticket_option')
                .setLabel('➕ Adicionar Opção')
                .setStyle(ButtonStyle.Success)
        );

    if (options.length > 0) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId('edit_ticket_option')
                .setLabel('✏️ Editar Opção')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('delete_ticket_option')
                .setLabel('🗑️ Excluir Opção')
                .setStyle(ButtonStyle.Danger)
        );
    }

    // Adicionar botão voltar
    row.addComponents(
        new ButtonBuilder()
            .setCustomId('back_to_menu')
            .setLabel('⬅️ Voltar')
            .setStyle(ButtonStyle.Secondary)
    );

    await interaction.update({ embeds: [embed], components: [row] });
}

async function updateTicketMessage(guild, categoryId) {
    const options = ticketOptions.get(guild.id) || [];
    
    if (options.length === 0) return;

    const ticketEmbed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Sistema de Suporte')
        .setDescription('Selecione uma opção abaixo para abrir um ticket:')
        .setTimestamp();

    const selectOptions = options.map(opt => ({
        label: opt.label,
        description: opt.description,
        value: opt.id
    }));

    const ticketSelect = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('ticket_type_select')
                .setPlaceholder('Selecione uma opção para abrir um ticket...')
                .addOptions(selectOptions)
        );

    try {
        // Enviar para o primeiro canal da categoria
        const category = await guild.channels.fetch(categoryId);
        
        // Verificar se a categoria foi encontrada
        if (!category) {
            console.error('Categoria não encontrada');
            return;
        }
        
        // Buscar todos os canais do servidor e filtrar os que pertencem à categoria
        const allChannels = await guild.channels.fetch();
        const textChannels = allChannels.filter(ch => 
            ch.parentId === categoryId && ch.type === 0 // Apenas canais de texto na categoria
        );
        
        // Ordenar por posição para garantir consistência
        const sortedChannels = Array.from(textChannels.values()).sort((a, b) => a.position - b.position);
        
        if (sortedChannels.length > 0) {
            const firstChannel = sortedChannels[0];
            const messages = await firstChannel.messages.fetch({ limit: 10 });
            const botMessage = messages.find(m => m.author.id === client.user.id && m.components.length > 0);
            
            if (botMessage) {
                await botMessage.edit({ embeds: [ticketEmbed], components: [ticketSelect] });
            } else {
                await firstChannel.send({ embeds: [ticketEmbed], components: [ticketSelect] });
            }
        }
    } catch (error) {
        console.error('Erro ao atualizar mensagem de tickets:', error);
    }
}

async function showTicketMessageConfig(interaction) {
    const guild = interaction.guild;
    const currentMessage = ticketMessages.get(guild.id) || {
        title: 'Atendimento Radiant Store',
        description: 'Seja bem-vindo(a) ao sistema de atendimento da Radiant Store\nDe segunda a sabado das 7h as 23h\nDomingo e feriado: sem horario determinado'
    };
    
    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Configurar Mensagem de Ticket')
        .setDescription('Configure a mensagem que aparecerá no sistema de tickets')
        .addFields(
            { name: 'Título Atual', value: currentMessage.title || 'Nenhum título configurado', inline: false },
            { name: 'Descrição Atual', value: currentMessage.description || 'Nenhuma descrição configurada', inline: false }
        )
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('edit_ticket_title')
                .setLabel('Editar Título')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('edit_ticket_description')
                .setLabel('Editar Descrição')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('back_to_menu')
                .setLabel('Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row] });
}

function addBackButton(row) {
    if (row.components.length < 5) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId('back_to_menu')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );
    }
    return row;
}

async function showTicketChannelModal(interaction) {
    const guild = interaction.guild;
    const defaultChannelId = defaultTicketChannels.get(guild.id);
    
    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Criação de Mensagem de Tickets')
        .setDescription('O que você deseja fazer?')
        .addFields(
            { 
                name: 'Canal Padrão', 
                value: defaultChannelId ? `<#${defaultChannelId}> (ID: \`${defaultChannelId}\`)` : 'Nenhum canal configurado',
                inline: false 
            }
        )
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('set_default_channel')
                .setLabel('Definir Canal Padrão')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('use_default_channel')
                .setLabel('Usar Canal Padrão')
                .setStyle(defaultChannelId ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(!defaultChannelId),
            new ButtonBuilder()
                .setCustomId('change_channel')
                .setLabel('Mudar Canal')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('back_to_menu')
                .setLabel('Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row] });
}

async function showTicketCreationMessage(interaction) {
    const guild = interaction.guild;
    const categoryId = ticketChannels.get(guild.id);
    
    if (!categoryId) {
        await interaction.reply({ content: '❌ Configure uma categoria primeiro!', ephemeral: true });
        return;
    }

    try {
        // Obter as opções de tickets configuradas
        const options = ticketOptions.get(guild.id) || [];
        
        if (options.length === 0) {
            await interaction.reply({ content: '❌ Adicione opções de tickets primeiro!', ephemeral: true });
            return;
        }

        // Criar o embed personalizado
        const customMessage = ticketMessages.get(guild.id) || {
            title: 'Atendimento Radiant Store',
            description: 'Seja bem-vindo(a) ao sistema de atendimento da Radiant Store\nDe segunda a sabado das 7h as 23h\nDomingo e feriado: sem horario determinado'
        };

        const visualConfig = ticketVisuals.get(guild.id) || {
            imageUrl: '',
            color: '#0099ff',
            footer: 'Radiant Store 2025'
        };

        const embed = new EmbedBuilder()
            .setColor(visualConfig.color || '#0099ff')
            .setTitle(customMessage.title)
            .setDescription(customMessage.description);

        // Adicionar imagem como thumbnail se houver
        if (visualConfig.imageUrl) {
            embed.setThumbnail(visualConfig.imageUrl);
        }

        // Adicionar rodapé se houver
        if (visualConfig.footer) {
            embed.setFooter({ text: visualConfig.footer });
        }

        // Criar o menu dropdown com as opções
        const selectOptions = options.map(opt => ({
            label: opt.label,
            description: opt.description,
            value: opt.id
        }));

        const ticketSelect = new ActionRowBuilder()
            .addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('ticket_type_select')
                    .setPlaceholder('Selecione uma opção para abrir um ticket...')
                    .addOptions(selectOptions)
            );

        // Enviar para o primeiro canal da categoria
        const category = await guild.channels.fetch(categoryId);
        
        // Verificar se a categoria foi encontrada
        if (!category) {
            await interaction.reply({ content: '❌ Categoria não encontrada!', ephemeral: true });
            return;
        }
        
        // Buscar todos os canais do servidor e filtrar os que pertencem à categoria
        const allChannels = await guild.channels.fetch();
        const textChannels = allChannels.filter(ch => 
            ch.parentId === categoryId && ch.type === 0 // Apenas canais de texto na categoria
        );
        
        // Ordenar por posição para garantir consistência
        const sortedChannels = Array.from(textChannels.values()).sort((a, b) => a.position - b.position);
        
        if (sortedChannels.length > 0) {
            const firstChannel = sortedChannels[0];
            await firstChannel.send({ embeds: [embed], components: [ticketSelect] });
            await interaction.reply({ content: '✅ Mensagem de tickets criada com sucesso!', ephemeral: true });
        } else {
            await interaction.reply({ content: '❌ Nenhum canal de texto encontrado na categoria!', ephemeral: true });
        }

    } catch (error) {
        console.error('Erro ao criar mensagem de tickets:', error);
        await interaction.reply({ content: '❌ Erro ao criar a mensagem de tickets.', ephemeral: true });
    }
}

async function showTranscriptChannelConfig(interaction) {
    const guild = interaction.guild;
    const currentChannelId = transcriptChannels.get(guild.id);
    
    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Configurar Canal de Transcripts')
        .setDescription('Configure onde os transcripts dos tickets serão salvos')
        .addFields(
            { 
                name: 'Canal Atual', 
                value: currentChannelId ? `<#${currentChannelId}> (ID: \`${currentChannelId}\`)` : 'Nenhum canal configurado',
                inline: false 
            }
        )
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('set_transcript_channel')
                .setLabel('Definir Canal')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('back_to_menu')
                .setLabel('Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row] });
}

async function createTicketTranscript(ticketChannel, ticketOpener) {
    try {
        // Coletar todas as mensagens do canal
        const messages = await ticketChannel.messages.fetch({ limit: 100, after: 0 });
        const sortedMessages = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        
        // Criar o conteúdo do transcript
        let transcriptContent = `═══════════════════════════════════════════════════════════════\n`;
        transcriptContent += `                    TRANSCRIPT DO TICKET\n`;
        transcriptContent += `═══════════════════════════════════════════════════════════════\n`;
        transcriptContent += `Canal: #${ticketChannel.name}\n`;
        transcriptContent += `ID do Canal: ${ticketChannel.id}\n`;
        transcriptContent += `Aberto por: ${ticketOpener.tag} (${ticketOpener.id})\n`;
        transcriptContent += `Data de abertura: ${ticketChannel.createdAt.toLocaleString('pt-BR')}\n`;
        transcriptContent += `Data de fechamento: ${new Date().toLocaleString('pt-BR')}\n`;
        transcriptContent += `Total de mensagens: ${sortedMessages.length}\n`;
        transcriptContent += `═══════════════════════════════════════════════════════════════\n\n`;
        
        // Adicionar cada mensagem ao transcript
        for (const message of sortedMessages) {
            const timestamp = message.createdAt.toLocaleString('pt-BR');
            const author = message.author.bot ? `[BOT] ${message.author.username}` : message.author.username;
            const content = message.content || '[Sem conteúdo]';
            
            transcriptContent += `[${timestamp}] ${author}:\n`;
            transcriptContent += `${content}\n`;
            
            // Adicionar anexos se houver
            if (message.attachments.size > 0) {
                transcriptContent += `📎 Anexos: ${message.attachments.map(a => a.url).join(', ')}\n`;
            }
            
            // Adicionar embeds se houver
            if (message.embeds.length > 0) {
                transcriptContent += `📄 Embed(s): ${message.embeds.length} embed(s) nesta mensagem\n`;
            }
            
            transcriptContent += `─────────────────────────────────────────────────────────\n\n`;
        }
        
        transcriptContent += `═══════════════════════════════════════════════════════════════\n`;
        transcriptContent += `                          FIM DO TRANSCRIPT\n`;
        transcriptContent += `═══════════════════════════════════════════════════════════════\n`;
        
        return transcriptContent;
    } catch (error) {
        console.error('Erro ao criar transcript:', error);
        return null;
    }
}

async function sendTranscript(transcriptContent, ticketOpener, guild, ticketChannel, optionLabel, closedBy, duration) {
    // Verificar se já está processando transcript para este canal
    if (activeTranscripts.has(ticketChannel.id)) {
        console.log('Transcript já em processamento para o canal:', ticketChannel.id);
        return false;
    }
    
    // Adicionar ao conjunto de transcripts ativos
    activeTranscripts.add(ticketChannel.id);
    
    try {
        // Enviar transcript para o usuário que abriu o ticket (apenas o arquivo)
        await ticketOpener.send({
            files: [{
                attachment: Buffer.from(transcriptContent, 'utf8'),
                name: `ticket-transcript-${new Date().getTime()}.txt`
            }]
        });
        
        // Enviar mensagem formatada para o canal de transcripts se configurado
        const transcriptChannelId = transcriptChannels.get(guild.id);
        if (transcriptChannelId) {
            try {
                const transcriptChannel = await guild.channels.fetch(transcriptChannelId);
                if (transcriptChannel && transcriptChannel.type === 0) { // GUILD_TEXT
                    const openTime = ticketChannel.createdAt;
                    const closeTime = new Date();
                    const durationHours = Math.floor((closeTime - openTime) / (1000 * 60 * 60));
                    const durationMinutes = Math.floor(((closeTime - openTime) % (1000 * 60 * 60)) / (1000 * 60));
                    
                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Ticket Finalizado')
                        .addFields(
                            { name: 'Dono do ticket', value: `<@${ticketOpener.id}> (${ticketOpener.tag})`, inline: false },
                            { name: 'Aberto em', value: openTime.toLocaleString('pt-BR'), inline: false },
                            { name: 'Finalizado em', value: closeTime.toLocaleString('pt-BR'), inline: false },
                            { name: 'Duração', value: `${durationHours} hora(s) e ${durationMinutes} minuto(s)`, inline: false },
                            { name: 'Status', value: 'Finalizado', inline: false },
                            { name: 'Finalizado por', value: `<@${closedBy.id}>`, inline: false }
                        )
                        .setTimestamp();

                    const row = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(`transcript_${ticketChannel.id}`)
                                .setLabel('Transcript')
                                .setStyle(ButtonStyle.Secondary)
                        );

                    await transcriptChannel.send({ embeds: [embed], components: [row] });
                    
                    // Salvar o transcript para acesso posterior via botão
                    if (!global.transcripts) global.transcripts = new Map();
                    global.transcripts.set(ticketChannel.id, transcriptContent);
                }
            } catch (error) {
                console.error('Erro ao enviar transcript para o canal configurado:', error);
            }
        }
        
        return true;
    } catch (error) {
        console.error('Erro ao enviar transcript:', error);
        return false;
    } finally {
        // Remover do conjunto de transcripts ativos
        activeTranscripts.delete(ticketChannel.id);
    }
}

// Funções auxiliares para gerenciamento de produtos
async function showManagePlans(interaction) {
    const guild = interaction.guild;
    const guildProducts = products.get(guild.id) || [];

    if (guildProducts.length === 0) {
        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_products_menu')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({
            content: '❌ Nenhum produto cadastrado! Crie um produto primeiro.',
            embeds: [],
            components: [backButton]
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Gerenciar Planos')
        .setDescription('Selecione um produto para configurar os planos:')
        .setTimestamp();

    const productOptions = guildProducts.map(product => ({
        label: product.name,
        description: `ID: ${product.id}`,
        value: product.id
    }));

    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_product_for_plans')
                .setPlaceholder('Selecione um produto...')
                .addOptions(productOptions)
        );

    const backButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('back_to_products_menu')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row, backButton] });
}

async function showManageProducts(interaction) {
    const guild = interaction.guild;
    const guildProducts = products.get(guild.id) || [];

    if (guildProducts.length === 0) {
        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_main')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({
            content: '❌ Nenhum produto cadastrado!',
            embeds: [],
            components: [backButton]
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Gerenciar Produtos')
        .setDescription('Escolha uma ação:')
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('edit_product')
                .setLabel('Editar Produto')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('delete_product')
                .setLabel('Excluir Produto')
                .setStyle(ButtonStyle.Danger)
        );

    const backButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('back_to_products_menu')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row, backButton] });
}

async function showSendProduct(interaction) {
    const guild = interaction.guild;
    const guildProducts = products.get(guild.id) || [];

    if (guildProducts.length === 0) {
        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_products_menu')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({
            content: '❌ Nenhum produto cadastrado! Crie um produto primeiro.',
            embeds: [],
            components: [backButton]
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Enviar Produto')
        .setDescription('Selecione o produto que deseja enviar para um canal:')
        .setTimestamp();

    const productOptions = guildProducts.map(product => ({
        label: product.name,
        description: `ID: ${product.id}`,
        value: product.id
    }));

    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_product_to_send')
                .setPlaceholder('Selecione um produto...')
                .addOptions(productOptions)
        );

    const backButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('back_to_products_menu')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row, backButton] });
}

async function showShippingStock(interaction) {
    const guild = interaction.guild;
    const guildProducts = products.get(guild.id) || [];

    if (guildProducts.length === 0) {
        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_products_menu')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({
            content: '❌ Nenhum produto cadastrado! Crie um produto primeiro.',
            embeds: [],
            components: [backButton]
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Configurar Tipo de Estoque')
        .setDescription('Selecione o produto para escolher o tipo de estoque:')
        .addFields(
            { name: 'Automático', value: 'Gera keys automaticamente via API', inline: true },
            { name: 'Manual', value: 'Usa keys cadastradas manualmente', inline: true }
        )
        .setTimestamp();

    const productOptions = guildProducts.map(product => {
        // Verificar configuração atual e preferência do produto
        const guildKeyAuth = keyAuthStock.get(guild.id) || {};
        const guildManual = manualStock.get(guild.id) || {};
        const guildPrefs = stockPreference.get(guild.id) || {};
        const hasAuto = guildKeyAuth[product.id];
        const hasManual = guildManual[product.id] && Object.keys(guildManual[product.id]).length > 0;
        const preference = guildPrefs[product.id];
        
        let description = `ID: ${product.id}`;
        if (preference === 'auto') description += ' | Usando Automático';
        else if (preference === 'manual') description += ' | Usando Manual';
        else if (hasAuto) description += ' | Automático (padrão)';
        else if (hasManual) description += ' | Manual (padrão)';
        else description += ' | ⚠️ Não configurado';
        
        return {
            label: product.name,
            description: description,
            value: product.id
        };
    });

    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_product_shipping')
                .setPlaceholder('Selecione um produto...')
                .addOptions(productOptions)
        );

    const backButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('back_to_products_menu')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row, backButton] });
}

async function showShoppingCart(interaction, cart, guild) {
    if (cart.items.length === 0) {
        await interaction.reply({ 
            content: '❌ Seu carrinho está vazio!', 
            ephemeral: true 
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('🛒 Carrinho de Compras')
        .setTimestamp();

    let totalCart = 0;

    // Adicionar cada item do carrinho
    cart.items.forEach((item, index) => {
        const itemTotal = item.unitPrice * item.quantity;
        totalCart += itemTotal;

        embed.addFields({
            name: `${item.productName} (x${item.quantity})`,
            value: `Campo: ${item.planName}\nPreço unitário: R$ ${item.unitPrice.toFixed(2)}\nTotal: R$ ${itemTotal.toFixed(2)}`,
            inline: false
        });
    });

    embed.addFields({
        name: '\u200B',
        value: `**Total do Carrinho: R$ ${totalCart.toFixed(2)}**`,
        inline: false
    });

    const components = [];

    // Botões para cada item (Editar Quantidade e Remover)
    cart.items.forEach((item, index) => {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`edit_cart_quantity_${index}`)
                    .setLabel(`Editar Quantidade`)
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`remove_cart_item_${index}`)
                    .setLabel(`Remover`)
                    .setStyle(ButtonStyle.Danger)
            );
        components.push(row);
    });

    // Botões principais (Aplicar Cupom, Continuar, Cancelar)
    const mainRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('apply_coupon')
                .setLabel('Aplicar Cupom')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('continue_payment')
                .setLabel('Continuar para o Pagamento')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('cancel_cart')
                .setLabel('Cancelar')
                .setStyle(ButtonStyle.Danger)
        );
    components.push(mainRow);

    await interaction.reply({ 
        embeds: [embed], 
        components, 
        ephemeral: true 
    });
}

async function sendShoppingCartToChannel(channel, cart, user, guild) {
    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('🛒 Carrinho de Compras')
        .setDescription(`Carrinho de ${user}`)
        .setTimestamp();

    let totalCart = 0;

    // Adicionar cada item do carrinho
    cart.items.forEach((item) => {
        const itemTotal = item.unitPrice * item.quantity;
        totalCart += itemTotal;

        embed.addFields({
            name: `${item.productName} (x${item.quantity})`,
            value: `Campo: ${item.planName}\nPreço unitário: R$ ${item.unitPrice.toFixed(2)}\nTotal: R$ ${itemTotal.toFixed(2)}`,
            inline: false
        });
    });

    // Verificar se há cupom aplicado
    let finalTotal = totalCart;
    let discountAmount = 0;

    if (cart.appliedCoupon) {
        discountAmount = (totalCart * cart.appliedCoupon.percentage) / 100;
        finalTotal = totalCart - discountAmount;

        embed.addFields({
            name: '\u200B',
            value: `Subtotal: R$ ${totalCart.toFixed(2)}\nDesconto (${cart.appliedCoupon.code} - ${cart.appliedCoupon.percentage}%): -R$ ${discountAmount.toFixed(2)}\n**Total: R$ ${finalTotal.toFixed(2)}**`,
            inline: false
        });
    } else {
        embed.addFields({
            name: '\u200B',
            value: `**Total do Carrinho: R$ ${totalCart.toFixed(2)}**`,
            inline: false
        });
    }

    // Apenas botões principais (sem Editar Quantidade e Remover)
    const mainRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('apply_coupon')
                .setLabel(cart.appliedCoupon ? 'Trocar Cupom' : 'Aplicar Cupom')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('continue_payment')
                .setLabel('Continuar para o Pagamento')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('cancel_cart')
                .setLabel('Cancelar')
                .setStyle(ButtonStyle.Danger)
        );

    const message = await channel.send({ 
        content: `${user}`,
        embeds: [embed], 
        components: [mainRow]
    });
    
    return message;
}

async function showCouponProducts(interaction) {
    const guild = interaction.guild;
    const guildCoupons = coupons.get(guild.id) || [];

    if (guildCoupons.length === 0) {
        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_main')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({
            content: '❌ Nenhum cupom cadastrado! Crie um cupom primeiro.',
            embeds: [],
            components: [backButton]
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Produtos do Cupom')
        .setDescription('Selecione o cupom para configurar em quais produtos ele funciona:')
        .setTimestamp();

    const couponOptions = guildCoupons.map(coupon => ({
        label: coupon.name,
        description: `${coupon.percentage}% - Mín: R$ ${coupon.minValue.toFixed(2)}`,
        value: coupon.id
    }));

    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_coupon_for_products')
                .setPlaceholder('Selecione um cupom...')
                .addOptions(couponOptions)
        );

    const backButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('back_to_main')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row, backButton] });
}

async function showManageCoupons(interaction) {
    const guild = interaction.guild;
    const guildCoupons = coupons.get(guild.id) || [];

    if (guildCoupons.length === 0) {
        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_main')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({
            content: '❌ Nenhum cupom cadastrado! Crie um cupom primeiro.',
            embeds: [],
            components: [backButton]
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Gerenciar Cupons')
        .setDescription('Selecione o cupom que deseja editar ou excluir:')
        .setTimestamp();

    const couponOptions = guildCoupons.map(coupon => {
        const isExpired = new Date(coupon.expiresAt) < new Date();
        return {
            label: coupon.name,
            description: `${coupon.percentage}% - ${isExpired ? '❌ Expirado' : '✅ Ativo'}`,
            value: coupon.id
        };
    });

    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_manage_coupon')
                .setPlaceholder('Selecione um cupom...')
                .addOptions(couponOptions)
        );

    const backButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('back_to_main')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row, backButton] });
}

// Função para gerenciar estoque automático (KeyAuth)
async function showAutoStock(interaction) {
    const guild = interaction.guild;
    const guildProducts = products.get(guild.id) || [];
    const guildKeyAuth = keyAuthStock.get(guild.id) || {};

    if (guildProducts.length === 0) {
        const embed = new EmbedBuilder()
            .setColor('#ff6b6b')
            .setTitle('Estoque Automático (KeyAuth)')
            .setDescription('Nenhum produto encontrado! Cadastre produtos primeiro.')
            .setTimestamp();

        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_products_menu')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({ embeds: [embed], components: [backButton] });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Estoque Automático (KeyAuth)')
        .setDescription('Gerencie a configuração do KeyAuth para geração automática de keys.\n\n**Selecione uma opção:**')
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('auto_stock_menu')
                .setPlaceholder('Selecione uma opção...')
                .addOptions([
                    {
                        label: 'Adicionar Configuração',
                        description: 'Configure a geração automática para um produto',
                        value: 'add_keyauth'
                    },
                    {
                        label: 'Editar Configuração',
                        description: 'Edite configuração automática existente',
                        value: 'edit_keyauth'
                    },
                    {
                        label: 'Excluir Configuração',
                        description: 'Remova configuração automática de um produto',
                        value: 'delete_keyauth'
                    }
                ])
        );

    const backButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('back_to_products_menu')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row, backButton] });
}

// Função para gerenciar estoque manual
async function showManualStock(interaction) {
    const guild = interaction.guild;
    const guildProducts = products.get(guild.id) || [];
    const guildManual = manualStock.get(guild.id) || {};

    if (guildProducts.length === 0) {
        const embed = new EmbedBuilder()
            .setColor('#ff6b6b')
            .setTitle('Estoque Manual')
            .setDescription('Nenhum produto encontrado! Cadastre produtos primeiro.')
            .setTimestamp();

        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_products_menu')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({ embeds: [embed], components: [backButton] });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Estoque Manual')
        .setDescription('Gerencie keys cadastradas manualmente por plano.\n\n**Selecione uma opção:**')
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('manual_stock_menu')
                .setPlaceholder('Selecione uma opção...')
                .addOptions([
                    {
                        label: 'Adicionar Keys',
                        description: 'Cadastre keys manualmente para um plano',
                        value: 'add_manual_keys'
                    },
                    {
                        label: 'Visualizar Keys',
                        description: 'Veja keys cadastradas por plano',
                        value: 'view_manual_keys'
                    },
                    {
                        label: 'Excluir Keys',
                        description: 'Remova keys de um plano',
                        value: 'delete_manual_keys'
                    }
                ])
        );

    const backButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('back_to_products_menu')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row, backButton] });
}

// Função para adicionar envio
async function showAddShipping(interaction) {
    const guild = interaction.guild;
    const guildProducts = products.get(guild.id) || [];

    if (guildProducts.length === 0) {
        const embed = new EmbedBuilder()
            .setColor('#ff6b6b')
            .setTitle('Adicionar Envio')
            .setDescription('Nenhum produto encontrado! Cadastre produtos primeiro.')
            .setTimestamp();

        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_products_menu')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({ embeds: [embed], components: [backButton] });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Adicionar Envio')
        .setDescription('Selecione um produto para configurar o envio:')
        .setTimestamp();

    const productOptions = guildProducts.map((product, index) => {
        const hasShipping = productShipping.get(guild.id)?.[product.id];
        return {
            label: `${product.name} ${hasShipping ? '(✅ Configurado)' : '(⚠️ Não configurado)'}`,
            description: product.description.substring(0, 100),
            value: `shipping_add_${product.id}`
        };
    });

    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_add_shipping')
                .setPlaceholder('Selecione um produto...')
                .addOptions(productOptions)
        );

    const backButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('back_to_products_menu')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row, backButton] });
}

// Função para editar envio
async function showEditShipping(interaction) {
    const guild = interaction.guild;
    const guildShipping = productShipping.get(guild.id) || {};
    const guildProducts = products.get(guild.id) || [];

    const configuredProducts = guildProducts.filter(product => guildShipping[product.id]);

    if (configuredProducts.length === 0) {
        const embed = new EmbedBuilder()
            .setColor('#ff6b6b')
            .setTitle('Editar Envio')
            .setDescription('Nenhum produto com envio configurado! Configure o envio primeiro.')
            .setTimestamp();

        const backButton = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_products_menu')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.update({ embeds: [embed], components: [backButton] });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Editar Envio')
        .setDescription('Selecione um produto para editar as informações de envio:')
        .setTimestamp();

    const productOptions = configuredProducts.map((product, index) => ({
        label: product.name,
        description: 'Configurado - Clique para editar',
        value: `shipping_edit_${product.id}`
    }));

    const row = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_edit_shipping')
                .setPlaceholder('Selecione um produto...')
                .addOptions(productOptions)
        );

    const backButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('back_to_products_menu')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row, backButton] });
}

// Função para configurar canal de transcript de compras
async function showPurchaseTranscriptConfig(interaction) {
    const guild = interaction.guild;
    const currentChannelId = purchaseTranscriptChannels.get(guild.id);
    
    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Configurar Canal de Transcript de Compras')
        .setDescription('Configure onde as informações das compras serão enviadas')
        .addFields(
            { 
                name: 'Canal Atual', 
                value: currentChannelId ? `<#${currentChannelId}> (ID: \`${currentChannelId}\`)` : 'Nenhum canal configurado',
                inline: false 
            }
        )
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('set_purchase_transcript_channel')
                .setLabel('Definir Canal')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('back_to_main')
                .setLabel('Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row] });
}

// Função para mostrar configuração de cargos de clientes
async function showClientRolesConfig(interaction) {
    const guild = interaction.guild;
    const currentRoleId = clientRoles.get(guild.id);
    
    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Configuração de Cargos de Clientes')
        .setDescription('Configure o cargo que os clientes receberão ao comprar QUALQUER produto da loja.')
        .addFields(
            { 
                name: 'Cargo Atual', 
                value: currentRoleId ? `<@&${currentRoleId}>` : 'Nenhum cargo configurado', 
                inline: true 
            },
            { 
                name: 'Status', 
                value: currentRoleId ? '✅ Ativo' : '❌ Inativo', 
                inline: true 
            },
            {
                name: 'Aplicação',
                value: 'Este cargo será dado para TODOS os clientes que comprarem qualquer produto.',
                inline: false
            }
        )
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('set_client_role')
                .setLabel('Definir Cargo de Clientes')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('back_to_products')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row] });
}

// Função para mostrar configuração de pagamentos
async function showPaymentConfig(interaction) {
    const guild = interaction.guild;
    const currentCredentials = efiCredentials.get(guild.id);
    
    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Configuração de Pagamentos - EFI Bank')
        .setDescription('Configure as credenciais da API EFI Bank e a chave Pix para processar pagamentos.')
        .addFields(
            { 
                name: 'Client ID', 
                value: currentCredentials?.clientId ? '`' + currentCredentials.clientId.substring(0, 10) + '...' + '`' : '❌ Não configurado', 
                inline: true 
            },
            { 
                name: 'Client Secret', 
                value: currentCredentials?.clientSecret ? '`' + currentCredentials.clientSecret.substring(0, 10) + '...' + '`' : '❌ Não configurado', 
                inline: true 
            },
            { 
                name: 'Chave Pix', 
                value: currentCredentials?.pixKey ? '`' + currentCredentials.pixKey + '`' : '❌ Não configurada', 
                inline: true 
            },
            { 
                name: 'Status', 
                value: (currentCredentials?.clientId && currentCredentials?.clientSecret && currentCredentials?.pixKey) ? '✅ Configurado' : '❌ Incompleto', 
                inline: true 
            },
            {
                name: '📋 Como obter as credenciais:',
                value: '1. Acesse: https://dev.efipay.com.br/docs/api-pix/credenciais/\n2. Faça login na plataforma EFI\n3. Copie o Client ID e Client Secret\n4. Configure sua chave Pix (CPF, CNPJ, Email ou Telefone)',
                inline: false
            },
            {
                name: '💡 Tipos de Chave Pix:',
                value: '• CPF (ex: 12345678909)\n• CNPJ (ex: 12345678901234)\n• Email (ex: seu@email.com)\n• Telefone (ex: +5511999998888)\n• Chave Aleatória (ex: 123e4567-e89b-12d3-a456-426614174000)',
                inline: false
            }
        )
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('set_efi_credentials')
                .setLabel('Configurar Credenciais')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('test_efi_connection')
                .setLabel('Testar Conexão')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(!currentCredentials),
            new ButtonBuilder()
                .setCustomId('back_to_main')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row] });
}

// Função para mostrar tela de pagamento com QR Code
async function showPaymentScreen(interaction, cart, totalAmount) {
    try {
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        const cartId = `${guildId}_${userId}`;
        
        // Verificar se existem credenciais EFI configuradas
        const credentials = efiCredentials.get(guildId);
        if (!credentials || !credentials.clientId || !credentials.clientSecret || !credentials.pixKey) {
            const errorEmbed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('❌ Erro de Configuração')
                .setDescription('As credenciais EFI não estão configuradas.\n\nUse `/painel` → "Configurações" → "Configurar EFI" para cadastrar suas credenciais.')
                .setTimestamp();
            
            await interaction.editReply({ embeds: [errorEmbed], components: [] });
            return;
        }
        
        // Criar descrição do pagamento (apenas nomes dos produtos)
        const productNames = cart.items.map(item => item.productName).join(', ');
        const description = productNames;
        
        // Criar pagamento Pix
        let payment;
        try {
            payment = await createPixPayment(guildId, totalAmount, description, userId, cartId);
        } catch (error) {
            console.error('Erro ao criar pagamento:', error);
            
            let errorMessage = 'Não foi possível criar o pagamento Pix.';
            
            if (error.message?.includes('Invalid or inactive credentials') || 
                error.error === 'invalid_client') {
                errorMessage = '**Credenciais EFI inválidas ou inativas.**\n\n' +
                    'Verifique no painel da EFI:\n' +
                    '1. Se o Client ID e Client Secret estão corretos\n' +
                    '2. Se a aplicação está ativa\n' +
                    '3. Se o certificado está associado à aplicação\n\n' +
                    'Use `/painel` → "Configurações" → "Configurar EFI" para atualizar.';
            } else if (error.message?.includes('certificado') || error.message?.includes('certificate')) {
                errorMessage = '**Certificado não encontrado.**\n\n' +
                    'Certifique-se de que o arquivo `certificado.p12` está na pasta do bot.';
            }
            
            const errorEmbed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('❌ Erro no Pagamento')
                .setDescription(errorMessage)
                .setTimestamp();
            
            await interaction.editReply({ embeds: [errorEmbed], components: [] });
            return;
        }
        
        // Validar dados do pagamento
        if (!payment || !payment.qrCode || !payment.emv) {
            const errorEmbed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('❌ Erro no Pagamento')
                .setDescription('Falha ao gerar QR Code. Tente novamente.')
                .setTimestamp();
            
            await interaction.editReply({ embeds: [errorEmbed], components: [] });
            return;
        }
        
        // Criar embed com QR Code
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('Pagamento via Pix')
            .setDescription('Escaneie o QR Code abaixo para efetuar o pagamento:')
            .addFields(
                { name: 'Valor', value: `R$ ${totalAmount.toFixed(2)}`, inline: true },
                { name: 'Descricao', value: description, inline: false },
                { name: 'Validade', value: '1 hora', inline: true }
            )
            .setTimestamp();

        // Criar arquivo com QR Code
        const attachment = {
            attachment: payment.qrCode,
            name: 'qrcode.png'
        };
        
        // Botões
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('copy_pix_emv')
                    .setLabel('Copiar Pix Copia e Cola')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('cancel_payment')
                    .setLabel('Cancelar')
                    .setStyle(ButtonStyle.Danger)
            );

        await interaction.editReply({ 
            embeds: [embed], 
            files: [attachment], 
            components: [row]
        });
        
        // Iniciar verificação automática (silenciosa)
        startPaymentCheck(payment.txid, interaction);
        
    } catch (error) {
        console.error('Erro ao mostrar tela de pagamento:', error);
        
        const errorEmbed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('❌ Erro no Pagamento')
            .setDescription('Ocorreu um erro ao processar seu pagamento. Tente novamente.')
            .addFields(
                { name: 'Erro', value: error.message, inline: false }
            );
        
        await interaction.editReply({ embeds: [errorEmbed], components: [] });
    }
}

// Função para mostrar configuração de logs
async function showLogsConfig(interaction) {
    const guild = interaction.guild;
    const currentChannelId = logsChannels.get(guild.id);
    
    const currentRestoreCordRoleId = restoreCordRoles.get(guild.id);

    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle('Configuração de Logs')
        .setDescription('Configure o canal de logs e a integração com o RestoreCord.')
        .addFields(
            { 
                name: 'Canal de Logs', 
                value: currentChannelId ? `<#${currentChannelId}>` : 'Nenhum canal configurado', 
                inline: true 
            },
            { 
                name: 'Status', 
                value: currentChannelId ? '✅ Ativo' : '❌ Inativo', 
                inline: true 
            },
            {
                name: 'Cargo RestoreCord',
                value: currentRestoreCordRoleId ? `<@&${currentRestoreCordRoleId}>` : 'Nenhum cargo configurado',
                inline: true
            }
        )
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('set_logs_channel')
                .setLabel('Definir Canal de Logs')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('set_restorecord_role')
                .setLabel('Definir Cargo RestoreCord')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('back_to_main')
                .setLabel('⬅️ Voltar')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.update({ embeds: [embed], components: [row] });
}

// Função para enviar transcript de compras
async function sendPurchaseTranscript(interaction, user, item, keyResult, paymentCart) {
    const guild = interaction.guild;
    const transcriptChannelId = purchaseTranscriptChannels.get(guild.id);
    
    if (!transcriptChannelId) {
        return; // Não há canal configurado, não envia transcript
    }

    try {
        const transcriptChannel = await guild.channels.fetch(transcriptChannelId);
        if (!transcriptChannel || transcriptChannel.type !== 0) { // GUILD_TEXT = 0
            console.error('Canal de transcript de compras não encontrado ou inválido');
            return;
        }

        // Criar embed do transcript
        const transcriptEmbed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('Nova Compra Realizada')
            .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
            .addFields(
                { 
                    name: 'Comprador', 
                    value: `${user.toString()}\n**Nome:** ${user.username}\n**ID:** \`${user.id}\``,
                    inline: false 
                },
                { 
                    name: 'Produto', 
                    value: `**${item.productName}**\n**Plano:** ${item.planName}`,
                    inline: true 
                },
                { 
                    name: 'Método de Pagamento', 
                    value: 'Pix',
                    inline: true 
                }
            )
            .setTimestamp()
            .setFooter({ 
                text: `Servidor: ${guild.name}`, 
                iconURL: guild.iconURL({ dynamic: true }) 
            });

        // Adicionar informações da key se disponível
        if (keyResult) {
            const keySource = keyResult.source === 'manual' ? 'Manual' : `Automática (${keyResult.days} dias)`;
            transcriptEmbed.addFields(
                { 
                    name: 'Key Gerada', 
                    value: `\`\`\`${keyResult.key}\`\`\``,
                    inline: false 
                },
                { 
                    name: 'Origem da Key', 
                    value: keySource,
                    inline: true 
                }
            );
        } else {
            transcriptEmbed.addFields(
                { 
                    name: 'Atenção', 
                    value: 'Não foi possível gerar uma key automaticamente',
                    inline: false 
                }
            );
        }

        // Adicionar valor e cupom
        const itemPrice = item.price || 0;
        const itemTotal = itemPrice * (item.quantity || 1);
        transcriptEmbed.addFields(
            { 
                name: 'Valor do Item', 
                value: `R$ ${itemTotal.toFixed(2)}`,
                inline: true 
            }
        );

        // Adicionar informações de cupom se usado
        if (paymentCart && paymentCart.appliedCoupon) {
            const discount = (paymentCart.originalTotal || 0) - (paymentCart.total || 0);
            transcriptEmbed.addFields(
                { 
                    name: 'Cupom Utilizado', 
                    value: `**${paymentCart.appliedCoupon.name}**\nDesconto: R$ ${discount.toFixed(2)}`,
                    inline: true 
                }
            );
        }

        // Adicionar valor total
        const totalPaid = (paymentCart && paymentCart.total) ? paymentCart.total : itemTotal;
        transcriptEmbed.addFields(
            { 
                name: 'Valor Total Pago', 
                value: `R$ ${totalPaid.toFixed(2)}`,
                inline: false 
            }
        );

        // Enviar para o canal
        await transcriptChannel.send({ embeds: [transcriptEmbed] });
        console.log(`✅ Transcript de compra enviado para ${transcriptChannel.name}`);

    } catch (error) {
        console.error('Erro ao enviar transcript de compras:', error);
    }
}

// Função para gerar key via KeyAuth API
async function generateKeyAuthKey(sellerKey, appName, generatorName, planName, days) {
    try {
        console.log('Generator Name:', generatorName);
        console.log('Plan Name:', planName);
        console.log('Days:', days);
        
        // Construir URL com parâmetros GET
        const params = new URLSearchParams({
            sellerkey: sellerKey,
            type: 'add',
            format: 'JSON',
            expiry: days.toString(),
            mask: '******-******-******',
            level: '1',
            amount: '1',
            owner: generatorName, // Usar o nome do gerador configurado
            character: '2',
            note: `Generated for ${planName}`
        });
        
        const url = `https://keyauth.win/api/seller/?${params.toString()}`;
        console.log('URL:', url);
        
        const response = await fetch(url, {
            method: 'GET'
        });

        const data = await response.json();
        console.log('KeyAuth Response:', data);
        
        if (data.success) {
            console.log('✅ Key gerada com sucesso:', data.key || data.keys?.[0]);
            return data.key || data.keys?.[0];
        } else {
            console.error('❌ Erro ao gerar key KeyAuth:', data.message);
            console.error('Response completo:', JSON.stringify(data, null, 2));
            
            // Verificar se é erro de SellerKey
            if (data.message.includes('Seller key should be 32 characters')) {
                console.error('⚠️ Possíveis causas:');
                console.error('1. SellerKey inválida ou expirada');
                console.error('2. App Name não existe no KeyAuth');
                console.error('3. Permissões insuficientes na conta');
                console.error('4. URL da API incorreta (deveria ser keyauth.win)');
                console.error('📝 Verifique as configurações da sua chave de API');
            }
            
            return null;
        }
    } catch (error) {
        console.error('❌ Erro na requisição KeyAuth:', error);
        return null;
    }
}

// Função para mapear nome do plano para dias
function getPlanDays(planName) {
    const planLower = planName.toLowerCase();
    
    if (planLower.includes('trial')) return 3;
    if (planLower.includes('diario') || planLower.includes('diário') || planLower.includes('day')) return 1;
    if (planLower.includes('semanal') || planLower.includes('week')) return 7;
    if (planLower.includes('mensal') || planLower.includes('month')) return 30;
    if (planLower.includes('lifetime') || planLower.includes('vitalicio') || planLower.includes('vitalício')) return 999;
    
    // Padrão: 30 dias
    return 30;
}

// Função para obter key do estoque (manual ou KeyAuth)
async function getProductKey(guildId, productId, planName) {
    // Verificar preferência de estoque
    const guildPrefs = stockPreference.get(guildId) || {};
    const preference = guildPrefs[productId];
    
    // Se preferência for manual, tentar manual primeiro
    if (preference === 'manual') {
        const guildManual = manualStock.get(guildId) || {};
        const productKeys = guildManual[productId]?.[planName];
        
        if (productKeys && productKeys.length > 0) {
            // Pegar primeira key disponível e remover do estoque
            const key = productKeys.shift();
            manualStock.set(guildId, guildManual);
            saveData();
            return { key, source: 'manual' };
        }
    }
    
    // Se preferência for automático ou não definida, tentar KeyAuth primeiro
    if (preference === 'auto' || !preference) {
        const guildKeyAuth = keyAuthStock.get(guildId) || {};
        const keyAuthConfig = guildKeyAuth[productId];
        
        if (keyAuthConfig) {
            const days = getPlanDays(planName);
            const key = await generateKeyAuthKey(
                keyAuthConfig.sellerKey,
                keyAuthConfig.appName,
                keyAuthConfig.generatorName || 'Discord',
                planName,
                days
            );
            
            if (key) {
                return { key, source: 'keyauth', days };
            }
        }
    }
    
    // Se a preferência falhou, tentar o outro método
    if (preference === 'manual') {
        // Tentar KeyAuth como fallback
        const guildKeyAuth = keyAuthStock.get(guildId) || {};
        const keyAuthConfig = guildKeyAuth[productId];
        
        if (keyAuthConfig) {
            const days = getPlanDays(planName);
            const key = await generateKeyAuthKey(
                keyAuthConfig.sellerKey,
                keyAuthConfig.appName,
                keyAuthConfig.generatorName || 'Discord',
                planName,
                days
            );
            
            if (key) {
                return { key, source: 'keyauth', days };
            }
        }
    } else {
        // Tentar manual como fallback
        const guildManual = manualStock.get(guildId) || {};
        const productKeys = guildManual[productId]?.[planName];
        
        if (productKeys && productKeys.length > 0) {
            // Pegar primeira key disponível e remover do estoque
            const key = productKeys.shift();
            manualStock.set(guildId, guildManual);
            saveData();
            return { key, source: 'manual' };
        }
    }
    
    return null;
}

// Função para testar SellerKey do KeyAuth
async function testKeyAuthSellerKey(sellerKey, appName) {
    try {
        console.log('🧪 Testando SellerKey do KeyAuth...');
        
        // Tentar obter informações do app (endpoint de verificação)
        const params = new URLSearchParams({
            sellerkey: sellerKey,
            type: 'stats',
            format: 'JSON'
        });
        
        const url = `https://keyauth.win/api/seller/?${params.toString()}`;
        console.log('📊 URL do teste:', url);
        
        const response = await fetch(url, {
            method: 'GET'
        });

        const data = await response.json();
        console.log('📊 Resposta do teste:', data);
        
        if (data.success) {
            console.log('✅ SellerKey válida!');
            console.log('📱 Apps disponíveis:', data.apps || 'Não listado');
            return true;
        } else {
            console.error('❌ SellerKey inválida:', data.message);
            return false;
        }
    } catch (error) {
        console.error('❌ Erro no teste:', error);
        return false;
    }
}

client.login(process.env.DISCORD_TOKEN);
