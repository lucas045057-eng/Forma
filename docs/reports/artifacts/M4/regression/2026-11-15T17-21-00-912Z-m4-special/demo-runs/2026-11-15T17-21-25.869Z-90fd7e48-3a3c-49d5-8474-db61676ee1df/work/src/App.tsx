import { useState } from 'react';
import { Button } from './components/Button';
import { ProductHero } from './components/ProductHero';

const benefits = [
  { number: '01', title: '让呼吸慢下来', text: '雪松与佛手柑，像雨后走进一片安静的森林。' },
  { number: '02', title: '让角落有温度', text: '琥珀色瓶身与木质瓶盖，把自然留在你喜欢的角落。' },
  { number: '03', title: '让日常有仪式', text: '读书、休息、等一杯茶，让淡淡香气陪你片刻。' },
];

export default function App() {
  const [action, setAction] = useState('');
  const [purchases, setPurchases] = useState(0);
  return (
    <main>
      <header className="navigation">
        <a className="brand" href="#home">木间<span>MUJIAN / SCENT & LIVING</span></a>
        <a href="#details">关于这缕香气</a>
      </header>
      <section id="home" className="hero">
        <div className="hero-copy">
          <p className="eyebrow">A LITTLE SPACE TO BREATHE</p>
          <h1>给生活，<br/>留一点香气。</h1>
          <p className="intro">把森林的温柔带回家。<br/>木间 · 雪松无火香薰，让每一次回家都值得期待。</p>
          <div className="price">¥ 168 <span> / 100 mL · 雪松与佛手柑</span></div>
          <div className="actions">
            <Button data-testid="buy-button" onClick={() => { setPurchases(value => value + 1); setAction('已加入购物袋（演示）'); }}>立即购买</Button>
            <Button className="button-secondary" data-testid="save-button" onClick={() => setAction('已收藏这缕香气（演示）')}>收藏香气</Button>
          </div>
          <p className="fine-print">一份给自己，也给生活的温柔礼物。</p>
        </div>
        <ProductHero/>
      </section>
      <section id="details" className="details">
        <p className="eyebrow">SMALL RITUALS, EVERY DAY</p>
        <h2>不必远行，也能亲近自然。</h2>
        <ul className="benefits" data-testid="benefits">
          {benefits.map(benefit => (
            <li key={benefit.number} data-testid="benefit-item">
              <span className="number">{benefit.number}</span>
              <h3>{benefit.title}</h3>
              <p>{benefit.text}</p>
            </li>
          ))}
        </ul>
        <Button data-testid="gift-button" onClick={() => setAction('已选择礼盒装（演示）')}>为重要的人选一份</Button>
      </section>
      <footer>木间 MUJIAN · 留一隅安静，给自己。</footer>
      <output className="action-status" data-testid="action-status" data-purchases={purchases} aria-live="polite">{action}</output>
    </main>
  );
}
