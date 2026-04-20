import { P } from '../lib/constants.js'
export default function Home() {
  return (
    <div style={{minHeight:'calc(100vh - 52px)',backgroundColor:P.cream}}>
      <div style={{maxWidth:'660px',margin:'0 auto',padding:'56px 20px 40px',textAlign:'center'}}>
        <div style={{fontSize:'3.5rem',marginBottom:'16px'}}>🌱</div>
        <h1 style={{color:P.green,fontSize:'2rem',fontWeight:700,margin:'0 0 10px'}}>Garden at the Ridge</h1>
        <p style={{color:P.mid,fontSize:'1rem',lineHeight:1.65,maxWidth:'480px',margin:'0 auto 40px'}}>
          Dave &amp; Jen's growing journal — Conway, Massachusetts.
        </p>
        <div style={{display:'inline-block',backgroundColor:P.greenPale,border:`1px solid ${P.greenLight}`,borderRadius:'10px',padding:'18px 28px',color:P.green,fontWeight:500,fontSize:'0.95rem',lineHeight:1.5}}>
          🌿 Season underway — April 2026
        </div>
      </div>
    </div>
  )
}
