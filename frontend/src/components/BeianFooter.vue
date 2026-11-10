<template>
  <!-- ICP/公安备案页脚：合规要求（工信部要求展示备案号并链接至备案系统）。
       公安备案办结后在其下方追加对应标识与链接。 -->
  <footer class="beian-footer">
    <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">沪ICP备2026059701号-1</a>
  </footer>
</template>

<style scoped>
.beian-footer {
  padding: 10px 0 12px;
  text-align: center;
  font-size: 12px;
  color: var(--dim, #888);
}
.beian-footer a { color: inherit; text-decoration: none; }
.beian-footer a:hover { color: var(--accent, #7c9cff); }
</style>
