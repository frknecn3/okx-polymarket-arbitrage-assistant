'use client';

import { usePolymarketBook } from '@/hooks/connectToPoly'
import React, { useEffect } from 'react'

type Props = {}

const PolyConnectionComponent = (props: Props) => {

    const { books, connected } = usePolymarketBook();

    useEffect(()=>{
        console.log("books changed")
    },[books])

    console.log(books)

    return (
        <div className='flex-1 border-r-4 border-r-sky-400'>
            <span className='w-full'>

            </span>
        </div>
    )
}

export default PolyConnectionComponent