import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { P } from '../lib/constants.js'

export default function AuthCallback() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  useEffect(() => {
    if (loading) return
    if (user) navigate('/dashboard', { replace: true })
  }, [loading, user, navigate])
  return (
    <div style={{ minHeight:'100dvh',backgroundColor:P.cream,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:'16px' }}>
      <div style={{fontSize:'2.5rem'}}>🌿</div>
      <p style={{color:P.mid,fontSize:'1rem',margin:0}}>Signing you in…</p>
    </div>
  )
}
