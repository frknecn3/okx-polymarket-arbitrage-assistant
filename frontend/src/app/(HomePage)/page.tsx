import React from 'react'
import OkxConnectionComponent from './OkxConnectionComponent'
import PolyConnectionComponent from './PolyConnectionComponent'
import ArbWidget from './ArbWidget'

type Props = {}

const HomePage = (props: Props) => {
  return (
    <div>
      <h1 className='text-4xl font-bold text-center h-40 flex items-center justify-center'>Connect To OKX</h1>
      <div className='flex justify-center items-center gap-8 w-120 m-auto min-h-80'>
        {/* <OkxConnectionComponent />
        <PolyConnectionComponent /> */}
        <ArbWidget />
      </div>
    </div>
  )
}

export default HomePage