import { AuthenticateWithRedirectCallback } from '@clerk/react'
import { P } from '../lib/constants.js'

export default function AuthCallback() {
  return (
    <div style={{ minHeight:'100dvh',backgroundColor:P.cream,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:'16px' }}>
      <div style={{fontSize:'2.5rem'}}>🌿</div>
      <AuthenticateWithRedirectCallback />
    </div>
  )
}
