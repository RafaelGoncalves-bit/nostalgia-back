# Game Server PS2 — Backend

Servidor separado para catálogo REST e ISOs por WebDAV somente leitura. Baseado no backend Node/Express do projeto original.

## Rodar

1. Copie `.env.example` para `.env` e configure senha forte.
2. Adicione `games/fallout/game.iso` ou edite `games/catalog.json`.
3. Execute `docker compose up -d --build`.
4. Verifique `http://IP_DO_SERVIDOR:8080/api/games` e `http://IP_DO_SERVIDOR:8080/health`.
5. O WebDAV escuta na porta `8081`, protegido por autenticação Basic.

**Segurança:** o exemplo usa HTTP somente para LAN/rede VPN confiável. Para internet, use HTTPS e autenticação adequada; não exponha a porta 8081 diretamente à internet. Não comite a senha nem distribua a mesma credencial a clientes desconhecidos.

A pasta `games/` é montada como somente leitura nos containers. A ISO não é transferida integralmente ao cliente; o PCSX2 lê blocos sob demanda pelo rclone/WinFsp.
