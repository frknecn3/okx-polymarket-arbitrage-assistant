'use client';

import { useGoldPrice } from '@/hooks/connectToOkx';
import React, { useEffect } from 'react'

type Props = {}

const OkxConnectionComponent = (props: Props) => {

    const { connected, data } = useGoldPrice();

    useEffect(() => {
        if (connected) console.log("CONNECTED")
        else console.log('DISCONNECTED')
    }, [connected]);

    useEffect(()=>{
        console.log("CHANGE IN DATA: ", data)
    },[data])

    return (
        <div>{(data as any)?.price}</div>
    )
}

export default OkxConnectionComponent