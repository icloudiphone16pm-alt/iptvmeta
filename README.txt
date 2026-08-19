META PLAY V3.16.0

Principais ajustes:
- Sessao persistente apos F5/atualizacao da pagina.
- Restauracao imediata do acesso salvo, com revalidacao em segundo plano.
- Migracao automatica das sessoes salvas pela V3.13.x.
- Logout continua removendo as credenciais armazenadas.
- Mantidos proxy de streams, HLS, MPEG-TS, logos e suporte mobile.

Executar:
1. npm install
2. npm start
3. Abra http://localhost:3000

Observacao: para conversao HLS no iPhone/iPad, o FFmpeg deve estar instalado no servidor.


V3.16: favoritos persistentes, histórico/recentes, progresso de filmes e interface de biblioteca aprimorada.


V4.1 - correção de reprodução no iPhone/iPad: reconstrução segura da URL Xtream e diagnóstico de FFmpeg.


META PLAY v4.2 - CORREÇÃO IPHONE / HLS
---------------------------------------
Esta versão usa ffmpeg-static. Não é necessário instalar FFmpeg manualmente no Windows.

INSTALAÇÃO:
1. Extraia o ZIP.
2. Abra o Prompt de Comando dentro da pasta do projeto.
3. Execute: npm install
4. Depois execute: npm start
5. Abra no celular usando o IP mostrado pelo computador, por exemplo http://192.168.0.110:3000

IMPORTANTE: ao trocar da v4.1 para v4.2, execute npm install novamente para baixar o FFmpeg integrado.
