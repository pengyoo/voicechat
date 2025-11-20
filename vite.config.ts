import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})


// import { defineConfig } from 'vite'
// import react from '@vitejs/plugin-react'
// import basicSsl from '@vitejs/plugin-basic-ssl'

// // https://vitejs.dev/config/
// export default defineConfig({
//   plugins: [
//     react(),
//     basicSsl() // ✨ 启用 HTTPS
//   ],
//   server: {
//     host: '0.0.0.0', // ✨ 允许局域网（手机）访问，不仅仅是本机
//     port: 5173,
//     https: true      // ✨ 强制开启 HTTPS
//   }
// })