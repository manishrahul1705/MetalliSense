import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE_PATH || './',
  envPrefix: mode === 'mock' ? ['VITE_MOCK_MODE', 'VITE_BASE_PATH'] : 'VITE_',
  build: { target: 'esnext' },
  plugins: [react(), ...(mode === 'mock' ? [{name:'local-demo-fonts', enforce:'pre', generateBundle(){ this.emitFile({type:'asset',fileName:'licenses/demo-fonts.txt',source:['Montserrat','JetBrainsMono'].map(name=>readFileSync(new URL('./src/assets/demo-fonts/OFL-'+name+'.txt',import.meta.url),'utf8')).join('\n\n')}); }, transform(code,id) { if (id.replaceAll('\\','/').endsWith('/src/index.css')) return code.replace(/^@import url\("[^"]+"\);/,readFileSync(new URL('./src/mock/fonts.css',import.meta.url),'utf8')); }}] : [])],
}))
