import { HandleSSOCallback, useClerk } from '@clerk/react'
import { useNavigate } from 'react-router-dom'
import { P, POST_LOGIN_ROUTE } from '../lib/constants.js'

export default function AuthCallback() {
  const navigate = useNavigate()
  const { setActive, client } = useClerk()
  return (
    <div style={{ minHeight:'100dvh',backgroundColor:P.cream,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:'16px' }}>
      <div style={{fontSize:'2.5rem'}}>🌿</div>
      <HandleSSOCallback
        navigateToApp={async ({ session, decorateUrl }) => {
          await setActive({ session, redirectUrl: decorateUrl(POST_LOGIN_ROUTE) })
        }}
        navigateToSignIn={() => navigate('/login')}
        navigateToSignUp={async () => {
          const signUp = client.signUp
          if (signUp?.status === 'complete' && signUp.createdSessionId) {
            await setActive({ session: signUp.createdSessionId, redirectUrl: POST_LOGIN_ROUTE })
          } else {
            navigate('/login')
          }
        }}
      />
    </div>
  )
}
