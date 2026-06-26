import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { config } from '@/lib/config'

export const authOptions: NextAuthOptions = {
  secret: config.auth.secret,
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null
        const expectedPassword = config.auth.users.get(credentials.username)
        if (!expectedPassword || expectedPassword !== credentials.password) return null
        return { id: credentials.username, name: credentials.username }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.name = user.name
      return token
    },
    async session({ session, token }) {
      if (token.name) session.user = { name: token.name as string, email: '', image: '' }
      return session
    },
  },
}
