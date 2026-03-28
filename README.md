# Discord Ticket Bot

Bot compacto para Discord com sistema de tickets.

## Funcionalidades

- `/painel` - Menu de configuração do bot
- Sistema de tickets com canal configurável
- Botões de gerenciamento (Encerrar, Gerenciar, Informações)
- Interface em português

## Instalação

1. Instale as dependências:
```bash
npm install
```

2. Configure o arquivo `.env` com suas credenciais do Discord

3. Inicie o bot:
```bash
npm start
```

## Como Usar

1. Use `/painel` para abrir o menu de configuração
2. Selecione "Configurar Tickets"
3. Digite o ID do canal onde os tickets serão criados
4. O bot enviará uma mensagem no canal configurada com o botão "Abrir Ticket"
5. Os usuários podem clicar para criar tickets privativos

## Permissões Necessárias

O bot precisa das seguintes permissões:
- Gerenciar Canais
- Enviar Mensagens
- Ler Mensagens
- Usar Interações
