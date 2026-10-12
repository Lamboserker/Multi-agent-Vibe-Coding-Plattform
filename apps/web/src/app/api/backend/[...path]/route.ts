import { NextRequest, NextResponse } from 'next/server'

const backendUrl = process.env.BACKEND_API_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000'

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, context)
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, context)
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, context)
}

async function proxyRequest(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params
  const target = new URL(`${backendUrl.replace(/\/$/, '')}/${path.join('/')}`)
  target.search = request.nextUrl.search

  const headers = new Headers()
  const contentType = request.headers.get('Content-Type')
  const authorization = request.headers.get('Authorization')
  const accept = request.headers.get('Accept')
  if (contentType) headers.set('Content-Type', contentType)
  if (authorization) headers.set('Authorization', authorization)
  if (accept) headers.set('Accept', accept)

  const body = request.method === 'GET' ? undefined : await request.text()
  const response = await fetch(target, {
    method: request.method,
    headers,
    body,
  })

  const text = await response.text()
  return new NextResponse(text, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
    },
  })
}
