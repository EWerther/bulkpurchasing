import type { Metadata } from 'next'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import './globals.css'
import { NavSidebar } from '@/components/shared/NavSidebar'
import { SessionProvider } from '@/components/shared/SessionProvider'

export const metadata: Metadata = {
  title: 'BulkPurchasing',
  description: 'TFM production & purchasing operations tool',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions)

  return (
    <html lang="en">
      <body className="bg-bg text-text-primary antialiased" style={{ fontFamily: "'Inter', 'DM Sans', sans-serif" }}>
        <SessionProvider session={session}>
          {session ? (
            <div className="flex h-screen overflow-hidden">
              <NavSidebar />
              <main className="flex-1 overflow-auto flex flex-col min-w-0">
                {children}
              </main>
            </div>
          ) : (
            children
          )}
        </SessionProvider>
      </body>
    </html>
  )
}
