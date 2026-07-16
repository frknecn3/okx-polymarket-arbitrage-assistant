import React from 'react'
import OkxConnectionComponent from './OkxConnectionComponent'

type Props = {}

const HomePage = (props: Props) => {
  return (
    <div>
      <h1 className='text-4xl font-bold text-center h-40 flex items-center justify-center'>Connect To OKX</h1>
      <div className='flex justify-center items-center'>
        <OkxConnectionComponent />
      </div>
    </div>
  )
}

export default HomePage